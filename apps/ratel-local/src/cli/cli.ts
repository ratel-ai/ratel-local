import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type BackupFs,
  ConfigRegistrationError,
  createConfigControlPlane,
  createLocalGitExcludeManager,
  createMutationEngine,
  createPreparedChangeCoordinator,
  createProjectAdmissionLock,
  createProjectRegistry,
  findProjectRoot,
  type HierarchyEnv,
  type ImportConflictStrategy,
  isSupportedAgentHostKind,
  type JsonFs,
  nodeFs,
  type PreparedChangeCoordinator,
  type ProjectRegistry,
  type RatelScopeRef,
  ratelConfigPath,
  type SupportedAgentHostKind,
  type TransportFactory,
} from "@ratel-ai/ratel-local-core";
import { type AgentPluginInstaller, installRatelAgentPlugin } from "../agent-plugin.js";
import { ArgError, type ParsedArgs, parseArgs } from "./args.js";
import { BACKUP_USAGE, runBackup } from "./handlers/backup.js";
import { runConnect } from "./handlers/connect.js";
import { daemonPaths, runDaemon } from "./handlers/daemon.js";
import { runDoctor } from "./handlers/doctor.js";
import { IMPORT_USAGE, runImport } from "./handlers/import.js";
import { LINK_USAGE, runLink } from "./handlers/link.js";
import { MCP_USAGE, runMcp } from "./handlers/mcp.js";
import { PROJECT_USAGE, runProject } from "./handlers/project.js";
import { runServe } from "./handlers/serve.js";
import { runSetup, SETUP_USAGE } from "./handlers/setup.js";
import { runSkill, SKILL_USAGE } from "./handlers/skill.js";
import { runStatusline } from "./handlers/statusline.js";
import type { CliServerMutationRequest, CliServerMutator, HandlerCtx } from "./handlers/types.js";
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
  installAgentPlugin?: AgentPluginInstaller;
  stdin?: () => Promise<string>;
  stdout?: (message: string) => void;
  projectRegistryFactory?: (homeDir: string) => ProjectRegistry;
  preparedChanges?: PreparedChangeCoordinator;
}

export interface RunCliResult {
  shutdown?: () => Promise<void>;
}

const TOP_USAGE = `usage: ratel-local <command> [args...]

Commands:
  serve    start the gateway over stdio (use --config <path>; repeat for multi-file merge,
           or --auto-config to load user/project/local Ratel configs)
  connect  bridge this agent session to the scoped local daemon [--project-root <path>]
  setup    interactively install or start the persistent daemon [--yes] [--port N]
  daemon   manage the loopback HTTP daemon and UI (run, install, status, daemon open)
  import   migrate agent MCP configs and native skills into Ratel
  link     install the agent plugin, falling back to MCP config when needed
  mcp      manage MCP servers (add, remove, list, get, edit, auth)
  backup   manage backup snapshots (list)
  project  manage registered project roots (list, add, remove)
  skill    manage scoped skills (skill import/list, add-scope, remove-scope, remove)
  doctor   recover interrupted mutations and diagnose scoped configuration/OAuth state
  statusline render or install the Claude Code Ratel statusline
  ui       open the persistent daemon UI [--no-open]

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

  if (parsed.group === "project" && parsed.verb === undefined) {
    log(PROJECT_USAGE);
    return {};
  }

  if (parsed.group === "skill" && parsed.verb === undefined) {
    log(SKILL_USAGE);
    return {};
  }

  if (parsed.group === "import" && parsed.flags.help === true) {
    log(IMPORT_USAGE);
    return {};
  }

  if (parsed.group === "link" && parsed.flags.help === true) {
    log(LINK_USAGE);
    return {};
  }

  if (parsed.group === "setup" && parsed.flags.help === true) {
    log(SETUP_USAGE);
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
    installAgentPlugin: options.installAgentPlugin ?? installRatelAgentPlugin,
    stdin: options.stdin,
    stdout: options.stdout,
  };
  if (options.preparedChanges) {
    ctx.preparedChanges = options.preparedChanges;
  } else if (ctx.fs === nodeFs && commandUsesPreparedChanges(parsed)) {
    const mutationEngine = await createMutationEngine({
      controlDir: join(ctx.env.homeDir, ".ratel"),
    });
    ctx.preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
  }

  if (parsed.group === "ui") {
    return runUi(parsed, ctx, log);
  }

  if (parsed.group === "connect") {
    return runConnect(parsed, ctx, { ...options, cliVersion: options.cliVersion }, log);
  }

  if (parsed.group === "setup") {
    const version = options.cliVersion ?? options.serverVersion;
    await runSetup(ctx, {
      ...options,
      serverVersion: options.serverVersion ?? version,
      expectedVersion: version,
      yes: parsed.flags.yes === true,
    });
    return {};
  }

  if (parsed.group === "daemon") {
    return runDaemon(
      parsed,
      ctx,
      { ...options, serverVersion: options.serverVersion ?? options.cliVersion },
      log,
    );
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
    const isMutation = parsed.verb === "add" || parsed.verb === "edit" || parsed.verb === "remove";
    const registry = options.projectRegistryFactory
      ? options.projectRegistryFactory(ctx.env.homeDir)
      : createProjectRegistry({ homeDir: ctx.env.homeDir });
    await runMcp(ctx, {
      ...(isMutation ? { mutateServer: createCliServerMutator(ctx, registry) } : {}),
    });
    return {};
  }

  if (parsed.group === "backup") {
    await runBackup(ctx);
    return {};
  }

  if (parsed.group === "project") {
    const registry = options.projectRegistryFactory
      ? options.projectRegistryFactory(ctx.env.homeDir)
      : createProjectRegistry({ homeDir: ctx.env.homeDir });
    await runProject(ctx, {
      registry,
      admissionLock: createProjectAdmissionLock({ controlDir: join(ctx.env.homeDir, ".ratel") }),
      removeThroughDaemon: (projectId) => removeProjectThroughRunningDaemon(ctx, projectId),
    });
    return {};
  }

  if (parsed.group === "skill") {
    const registry = options.projectRegistryFactory
      ? options.projectRegistryFactory(ctx.env.homeDir)
      : createProjectRegistry({ homeDir: ctx.env.homeDir });
    await runSkill(ctx, { registry });
    return {};
  }

  if (parsed.group === "doctor") {
    await runDoctor(ctx);
    return {};
  }

  if (parsed.group === "statusline") {
    await runStatusline(ctx);
    return {};
  }

  throw new ArgError(`unhandled command: ${parsed.group} ${parsed.verb}`);
}

function commandUsesPreparedChanges(parsed: ParsedArgs): boolean {
  if (parsed.group === "import" || parsed.group === "link") return true;
  if (parsed.group === "statusline") {
    return parsed.verb === "install" || parsed.verb === "uninstall";
  }
  if (parsed.group === "mcp") {
    return parsed.verb === "add" || parsed.verb === "edit" || parsed.verb === "remove";
  }
  if (parsed.group === "skill") {
    return [
      "import",
      "add-scope",
      "remove-scope",
      "remove",
      "install-hook",
      "uninstall-hook",
    ].includes(parsed.verb ?? "");
  }
  return false;
}

function createCliServerMutator(ctx: HandlerCtx, registry: ProjectRegistry): CliServerMutator {
  return async (request) => {
    const { target, projectRoot } = await cliMutationTarget(ctx, registry, request.scope);
    const path = ratelConfigPath(request.scope, {
      homeDir: ctx.env.homeDir,
      ...(projectRoot ? { projectRoot } : {}),
    });
    const daemonResult = await mutateServerThroughRunningDaemon(ctx, request, target);
    if (daemonResult) return { path };

    const preparedChanges =
      ctx.preparedChanges ??
      createPreparedChangeCoordinator({
        mutationEngine: await createMutationEngine({
          controlDir: join(ctx.env.homeDir, ".ratel"),
        }),
      });
    const control = await createConfigControlPlane({
      homeDir: ctx.env.homeDir,
      projectRegistry: registry,
      preparedChanges,
      localGitExcludeManager: createLocalGitExcludeManager(),
    });
    try {
      await control.mutateServer({
        target,
        action: request.action,
        name: request.name,
        ...(request.entry ? { entry: request.entry } : {}),
        ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
      });
    } catch (error) {
      if (
        request.action === "add" &&
        request.force === true &&
        error instanceof ConfigRegistrationError &&
        error.reason === "registration_exists"
      ) {
        await control.mutateServer({
          target,
          action: "edit",
          name: request.name,
          entry: request.entry,
          ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
        });
      } else {
        throw error;
      }
    }
    return { path };
  };
}

async function cliMutationTarget(
  ctx: HandlerCtx,
  registry: ProjectRegistry,
  scope: CliServerMutationRequest["scope"],
): Promise<{ target: RatelScopeRef; projectRoot?: string }> {
  if (scope === "user") return { target: { scope: "user" } };
  if (!ctx.env.projectRoot) throw new ArgError(`scope "${scope}" requires a project root`);
  const project = await registry.registerRoot(ctx.env.projectRoot);
  return {
    target: { scope, projectId: project.id },
    projectRoot: project.canonicalRoot,
  };
}

async function mutateServerThroughRunningDaemon(
  ctx: HandlerCtx,
  request: CliServerMutationRequest,
  target: RatelScopeRef,
): Promise<boolean> {
  const stateText = await ctx.fs.read(daemonPaths(ctx.env.homeDir).state);
  const daemonToken = await ctx.fs.read(join(ctx.env.homeDir, ".ratel", "daemon-token"));
  if (!stateText || !daemonToken?.trim()) return false;
  let state: { uiUrl?: unknown; port?: unknown };
  try {
    state = JSON.parse(stateText) as { uiUrl?: unknown; port?: unknown };
  } catch {
    return false;
  }
  const baseUrl =
    typeof state.uiUrl === "string"
      ? state.uiUrl
      : typeof state.port === "number"
        ? `http://127.0.0.1:${state.port}`
        : undefined;
  if (!baseUrl) return false;
  const endpoint =
    request.action === "add" ? "/api/servers" : `/api/servers/${encodeURIComponent(request.name)}`;
  const invoke = async (action: CliServerMutationRequest["action"]): Promise<Response | null> => {
    try {
      return await fetch(new URL(endpoint, baseUrl), {
        method: action === "add" ? "POST" : action === "edit" ? "PATCH" : "DELETE",
        headers: {
          Authorization: `Bearer ${daemonToken.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target,
          name: request.name,
          ...(request.entry ? { entry: request.entry } : {}),
          ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
        }),
      });
    } catch {
      return null;
    }
  };
  let response = await invoke(request.action);
  if (!response) return false;
  if (response.status === 409 && request.action === "add" && request.force === true) {
    response = await fetch(new URL(`/api/servers/${encodeURIComponent(request.name)}`, baseUrl), {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${daemonToken.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ target, entry: request.entry }),
    });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new ArgError(
      body && typeof body.error === "string"
        ? body.error
        : `daemon refused MCP mutation: HTTP ${response.status}`,
    );
  }
  return true;
}

async function removeProjectThroughRunningDaemon(
  ctx: HandlerCtx,
  projectId: string,
): Promise<boolean> {
  const stateText = await ctx.fs.read(daemonPaths(ctx.env.homeDir).state);
  const daemonToken = await ctx.fs.read(join(ctx.env.homeDir, ".ratel", "daemon-token"));
  if (!stateText || !daemonToken?.trim()) return false;

  let state: { uiUrl?: unknown; port?: unknown };
  try {
    state = JSON.parse(stateText) as { uiUrl?: unknown; port?: unknown };
  } catch {
    return false;
  }
  const baseUrl =
    typeof state.uiUrl === "string"
      ? state.uiUrl
      : typeof state.port === "number"
        ? `http://127.0.0.1:${state.port}`
        : undefined;
  if (!baseUrl) return false;

  let response: Response;
  try {
    response = await fetch(new URL(`/api/projects/${encodeURIComponent(projectId)}`, baseUrl), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${daemonToken.trim()}` },
    });
  } catch {
    return false;
  }
  if (response.ok) return true;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  const message =
    body && typeof body.error === "string"
      ? body.error
      : `daemon refused project removal: HTTP ${response.status}`;
  throw new ArgError(message);
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
