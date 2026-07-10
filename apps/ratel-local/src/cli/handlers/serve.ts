import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  buildGatewayFromConfig,
  createMcpServer,
  findProjectRoot,
  type HierarchyEnv,
  mergeConfigs,
  ProjectRootNotFoundError,
  parseConfig,
  ratelConfigPath,
  type TransportFactory,
} from "@ratel-ai/ratel-local-core";
import type { TraceSinkConfig } from "@ratel-ai/sdk";
import type { ParsedArgs } from "../args.js";
import { defaultTelemetryDir, projectBucketDir } from "../telemetry-paths.js";

export interface ServeOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  serverName?: string;
  serverVersion?: string;
  env?: HierarchyEnv;
  processEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  existsSync?: (path: string) => boolean;
}

export interface ServeResult {
  shutdown: () => Promise<void>;
}

export interface ConfiguredGateway {
  config: ReturnType<typeof mergeConfigs>;
  gateway: Awaited<ReturnType<typeof buildGatewayFromConfig>>;
}

export interface AutoConfigResolution {
  configPaths: string[];
  projectRoot?: string;
  projectRootSource?: "flag" | "RATEL_PROJECT_ROOT" | "CLAUDE_PROJECT_DIR" | "cwd";
}

export async function runServe(
  parsed: ParsedArgs,
  options: ServeOptions,
  log: (m: string) => void,
): Promise<ServeResult> {
  const { config, gateway } = await buildConfiguredGateway(parsed, options, log);

  const downstream = options.serverTransport ?? new StdioServerTransport();
  const exposed = await createMcpServer(gateway.catalog, {
    name: options.serverName ?? "ratel",
    version: options.serverVersion ?? "0.0.0",
    transport: downstream,
    upstreamServers: gateway.upstreamServers,
    runAuthFlow: gateway.runAuthFlow,
    skillCatalog: gateway.skillCatalog,
  });
  gateway.setListChangedNotifier(exposed.notifyToolListChanged);

  const upstreamCount = Object.keys(config.mcpServers).length;
  log(`[ratel] ready, ${upstreamCount} upstream server(s) configured`);

  return {
    shutdown: async () => {
      await exposed.close();
      await gateway.close();
    },
  };
}

export async function buildConfiguredGateway(
  parsed: ParsedArgs,
  options: ServeOptions,
  log: (m: string) => void,
): Promise<ConfiguredGateway> {
  const command = parsed.group;
  const autoConfig = booleanFlag(parsed.flags["auto-config"]);
  if (autoConfig && parsed.configPaths.length > 0) {
    throw new Error(`ratel-local ${command}: --auto-config cannot be combined with --config paths`);
  }
  if (!autoConfig && parsed.configPaths.length === 0) {
    throw new Error(`usage: ratel-local ${command} <config.json> [--config <path> ...]`);
  }

  const readConfig = options.readConfig ?? defaultReadConfig;
  const configPaths = autoConfig
    ? resolveAutoConfig(parsed, options, log).configPaths
    : parsed.configPaths;
  const parts = [];
  for (const p of configPaths) {
    const raw = await readConfig(p);
    parts.push(parseConfig(raw));
  }
  const config = mergeConfigs(parts);

  const trace = await resolveTraceSink(parsed, log, options.cwd ?? process.cwd());

  const gateway = await buildGatewayFromConfig(config, {
    transportFactory: options.transportFactory,
    logger: log,
    ...(trace ? { trace } : {}),
  });

  return { config, gateway };
}

export function resolveAutoConfig(
  parsed: ParsedArgs,
  options: Pick<ServeOptions, "env" | "processEnv" | "cwd" | "existsSync"> = {},
  log: (m: string) => void = () => {},
): AutoConfigResolution {
  const homeDir = options.env?.homeDir ?? homedir();
  const processEnv = options.processEnv ?? process.env;
  const explicitProjectRoot = stringFlag(parsed.flags["project-root"], "--project-root");
  const projectRoot = resolveProjectRoot({
    explicitProjectRoot,
    envProjectRoot: processEnv.RATEL_PROJECT_ROOT,
    claudeProjectDir: processEnv.CLAUDE_PROJECT_DIR,
    cwd: options.cwd ?? process.cwd(),
    exists: options.existsSync ?? existsSync,
  });

  const configPaths = [ratelConfigPath("user", { homeDir })];
  if (projectRoot.root) {
    const env: HierarchyEnv = { homeDir, projectRoot: projectRoot.root };
    configPaths.push(ratelConfigPath("project", env), ratelConfigPath("local", env));
  }

  log(
    projectRoot.root
      ? `[ratel] auto-config project root: ${projectRoot.root} (${projectRoot.source})`
      : "[ratel] auto-config project root: not found; loading user config only",
  );
  log(`[ratel] auto-config paths: ${configPaths.join(", ")}`);

  return {
    configPaths,
    ...(projectRoot.root
      ? { projectRoot: projectRoot.root, projectRootSource: projectRoot.source }
      : {}),
  };
}

function booleanFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function stringFlag(value: unknown, name: string): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${name} requires a path value`);
}

function resolveProjectRoot(input: {
  explicitProjectRoot?: string;
  envProjectRoot?: string;
  claudeProjectDir?: string;
  cwd: string;
  exists: (path: string) => boolean;
}): { root?: string; source?: AutoConfigResolution["projectRootSource"] } {
  if (input.explicitProjectRoot) {
    return { root: resolve(input.explicitProjectRoot), source: "flag" };
  }
  if (input.envProjectRoot) {
    return { root: resolve(input.envProjectRoot), source: "RATEL_PROJECT_ROOT" };
  }
  if (input.claudeProjectDir) {
    return { root: resolve(input.claudeProjectDir), source: "CLAUDE_PROJECT_DIR" };
  }
  try {
    return { root: findProjectRoot(input.cwd, { existsSync: input.exists }), source: "cwd" };
  } catch (err) {
    if (err instanceof ProjectRootNotFoundError) return {};
    throw err;
  }
}

async function resolveTraceSink(
  parsed: ParsedArgs,
  log: (m: string) => void,
  cwd: string,
): Promise<TraceSinkConfig | undefined> {
  const flag = parsed.flags.telemetry;
  const flagFile = parsed.flags["telemetry-file"];
  const env = process.env.RATEL_TELEMETRY;
  if (flag === false || flag === "off" || env === "off") {
    return { kind: "noop" };
  }
  const sessionId = newSessionId();
  if (typeof flagFile === "string" && flagFile.length > 0) {
    return { kind: "jsonl", sessionId, path: flagFile };
  }
  const bucket = projectBucketDir(defaultTelemetryDir(), cwd);
  try {
    await mkdir(bucket, { recursive: true });
  } catch (err) {
    log(`[ratel] could not create telemetry dir ${bucket}: ${(err as Error).message}; disabling`);
    return { kind: "noop" };
  }
  const path = join(bucket, `${sessionId}.jsonl`);
  return { kind: "jsonl", sessionId, path };
}

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

async function defaultReadConfig(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { mcpServers: {} };
    }
    throw err;
  }
}
