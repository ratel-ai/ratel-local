import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type BackupFs,
  findProjectRoot,
  type HierarchyEnv,
  type ImportConflictStrategy,
  isSupportedAgentHostKind,
  type JsonFs,
  nodeFs,
  type SupportedAgentHostKind,
  type TransportFactory,
} from "@ratel-ai/ratel-local-core";
import { ArgError, type ParsedArgs, parseArgs } from "./args.js";
import { BACKUP_USAGE, runBackup } from "./handlers/backup.js";
import { runDaemon } from "./handlers/daemon.js";
import { runImport } from "./handlers/import.js";
import { runLink } from "./handlers/link.js";
import { MCP_USAGE, runMcp } from "./handlers/mcp.js";
import { runServe } from "./handlers/serve.js";
import { runSkill, SKILL_USAGE } from "./handlers/skill.js";
import { runStatusline } from "./handlers/statusline.js";
import type { HandlerCtx } from "./handlers/types.js";
import { runUi } from "./handlers/ui.js";
import { type PromptAdapter, silentPromptAdapter } from "./prompts.js";

export interface RunCliOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  logger?: (message: string) => void;
  serverName?: string;
  serverVersion?: string;
  prompts?: PromptAdapter;
  fs?: JsonFs & BackupFs;
  env?: HierarchyEnv;
  now?: () => Date;
  cliVersion?: string;
  stdin?: () => Promise<string>;
  stdout?: (message: string) => void;
}

export interface RunCliResult {
  shutdown?: () => Promise<void>;
}

const TOP_USAGE = `usage: ratel-local <command> [args...]

Commands:
  serve    start the gateway over stdio (use --config <path>; repeat for multi-file merge,
           or --auto-config to load user/project/local Ratel configs)
  daemon   start a loopback HTTP daemon with /mcp plus the UI/API [--port N] [--no-open]
  import   migrate agent MCP configs and native skills into Ratel
  link     point an agent at Ratel while preserving native MCP entries
  mcp      manage MCP servers (add, remove, list, get, edit, auth)
  backup   manage backup snapshots (list)
  skill    manage Claude Code/Codex skills through Ratel (activate, deactivate, list)
  statusline render or install the Claude Code Ratel statusline
  ui       launch a local browser UI mirroring the CLI [--port N] [--no-open]

Run \`ratel-local <group>\` for the verbs available in a group.`;

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const log = options.logger ?? ((m) => console.error(m));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      log(`${err.message}\n${TOP_USAGE}`);
    }
    throw err;
  }

  if (parsed.group === "help") {
    log(TOP_USAGE);
    return {};
  }

  if (parsed.group === "version") {
    log(options.cliVersion ?? options.serverVersion ?? "0.0.0");
    return {};
  }

  if (parsed.group === "mcp" && parsed.verb === undefined) {
    log(MCP_USAGE);
    return {};
  }

  if (parsed.group === "backup" && parsed.verb === undefined) {
    log(BACKUP_USAGE);
    return {};
  }

  if (parsed.group === "skill" && parsed.verb === undefined) {
    log(SKILL_USAGE);
    return {};
  }

  if (parsed.group === "serve") {
    return runServe(parsed, options, log);
  }

  const ctx: HandlerCtx = {
    argv: parsed,
    env: options.env ?? defaultEnv(),
    fs: options.fs ?? nodeFs,
    log,
    prompts: options.prompts ?? silentPromptAdapter(),
    stdin: options.stdin,
    stdout: options.stdout,
  };

  if (parsed.group === "ui") {
    return runUi(parsed, ctx, log);
  }

  if (parsed.group === "daemon") {
    return runDaemon(parsed, ctx, options, log);
  }

  if (parsed.group === "import") {
    await runImport(ctx, {
      yes: parsed.flags.yes === true,
      dryRun: parsed.flags["dry-run"] === true,
      conflictStrategy: resolveImportConflictStrategy(parsed.flags["conflict-strategy"]),
      agentKind: resolveAgentKind(parsed.flags.agent),
    });
    return {};
  }

  if (parsed.group === "link") {
    await runLink(ctx, {
      yes: parsed.flags.yes === true,
      agentKind: resolveAgentKind(parsed.flags.agent),
    });
    return {};
  }

  if (parsed.group === "mcp") {
    await runMcp(ctx);
    return {};
  }

  if (parsed.group === "backup") {
    await runBackup(ctx);
    return {};
  }

  if (parsed.group === "skill") {
    await runSkill(ctx);
    return {};
  }

  if (parsed.group === "statusline") {
    await runStatusline(ctx);
    return {};
  }

  throw new ArgError(`unhandled command: ${parsed.group} ${parsed.verb}`);
}

function resolveAgentKind(value: unknown): SupportedAgentHostKind | undefined {
  if (value === undefined || value === false || value === "auto") return undefined;
  if (typeof value !== "string") {
    throw new ArgError("--agent must be one of auto|claude-code|codex");
  }
  if (!isSupportedAgentHostKind(value)) {
    throw new ArgError(`--agent must be one of auto|claude-code|codex, got "${value}"`);
  }
  return value;
}

function resolveImportConflictStrategy(value: unknown): ImportConflictStrategy | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "string") {
    throw new ArgError(
      "--conflict-strategy must be one of add-missing-only|replace-selected|replace-from-agent",
    );
  }
  if (
    value !== "add-missing-only" &&
    value !== "replace-selected" &&
    value !== "replace-from-agent"
  ) {
    throw new ArgError(
      `--conflict-strategy must be one of add-missing-only|replace-selected|replace-from-agent, got "${value}"`,
    );
  }
  return value;
}

function defaultEnv(): HierarchyEnv {
  const env: HierarchyEnv = { homeDir: homedir() };
  try {
    env.projectRoot = findProjectRoot(process.cwd(), { existsSync });
  } catch {
    // no project root; project/local scopes will surface a clear error when used
  }
  return env;
}
