import { execSync } from "node:child_process";
import { join } from "node:path";
import type { AgentHostState, AgentScope } from "./agent-host/index.js";
import { AutomaticAgentHostAdapter } from "./agent-host/index.js";
import {
  type BackupFs,
  type BackupManifest,
  listBackups,
  restoreLatest,
  startBackup,
} from "./backup.js";
import { isRatelGatewayEntry } from "./gateway-entry.js";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "./hierarchy.js";
import {
  buildAgentImportPlan,
  type ImportConflictStrategy,
  type ImportPlan,
} from "./import-plan.js";
import { type JsonFs, readJson, writeJson } from "./io.js";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  buildGatewayFromConfig,
  mergeConfigs,
  parseConfig,
  type RatelConfig,
  type ServerEntry,
} from "./lib/index.js";
import { locateRatelBin, type ResolvedBin } from "./locate-bin.js";
import { executePlan } from "./plan-exec.js";

export type CoreFs = JsonFs & BackupFs;

export interface CoreContext {
  env: {
    homeDir: string;
    projectRoot?: string;
  };
  fs: CoreFs;
  log?: (message: string) => void;
}

export type AuthStatus = "n/a" | "needs auth" | "expired" | "ok";

export interface ConfigScopeStateAvailable {
  available: true;
  path: string;
  config: RatelConfig;
  authStatus: Record<string, AuthStatus>;
}

export interface ConfigScopeStateUnavailable {
  available: false;
}

export type ConfigScopeState = ConfigScopeStateAvailable | ConfigScopeStateUnavailable;

export interface ConfigState {
  homeDir: string;
  projectRoot: string | null;
  scopes: Record<RatelScope, ConfigScopeState>;
  backups: BackupManifest[];
}

export interface EntryMutationResult {
  name: string;
  scope: RatelScope;
  path: string;
  manifest: BackupManifest;
}

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

export function assertRatelScope(s: unknown): RatelScope {
  if (s === "user" || s === "project" || s === "local") return s;
  throw new Error(`scope must be one of user|project|local, got ${JSON.stringify(s)}`);
}

export async function resolveAuthStatus(
  ctx: Pick<CoreContext, "env" | "fs">,
  name: string,
  entry: ServerEntry,
): Promise<AuthStatus> {
  if (entry.type !== "http" && entry.type !== "sse") return "n/a";
  if (!ctx.env.homeDir) return "needs auth";
  const path = join(ctx.env.homeDir, ".ratel", "oauth", `${name}.json`);
  const stored = await readJson<{ tokens?: { access_token?: string }; expires_at?: number }>(
    ctx.fs,
    path,
  );
  if (!stored?.tokens?.access_token) return "needs auth";
  if (typeof stored.expires_at === "number" && stored.expires_at < Date.now()) {
    return "expired";
  }
  return "ok";
}

export async function getConfigState(ctx: CoreContext): Promise<ConfigState> {
  const scopes = {} as Record<RatelScope, ConfigScopeState>;
  for (const scope of SCOPES) {
    let path: string;
    try {
      path = ratelConfigPath(scope, ctx.env);
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) {
        scopes[scope] = { available: false };
        continue;
      }
      throw err;
    }
    const cfg = (await readJson<RatelConfig>(ctx.fs, path)) ?? { mcpServers: {} };
    const authStatus: Record<string, AuthStatus> = {};
    for (const [name, entry] of Object.entries(cfg.mcpServers)) {
      authStatus[name] = await resolveAuthStatus(ctx, name, entry);
    }
    scopes[scope] = { available: true, path, config: cfg, authStatus };
  }
  return {
    homeDir: ctx.env.homeDir,
    projectRoot: ctx.env.projectRoot ?? null,
    scopes,
    backups: await listBackups(ctx.env, ctx.fs),
  };
}

export async function addServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string; entry: ServerEntry; overwrite?: boolean },
): Promise<EntryMutationResult> {
  parseConfig({ mcpServers: { [input.name]: input.entry } });

  const path = ratelConfigPath(input.scope, ctx.env);
  const current = (await readJson<RatelConfig>(ctx.fs, path)) ?? { mcpServers: {} };
  if (current.mcpServers[input.name] && !input.overwrite) {
    throw new Error(`entry "${input.name}" already exists at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("add");

  current.mcpServers[input.name] = input.entry;
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
}

export async function editServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string; entry: ServerEntry },
): Promise<EntryMutationResult> {
  parseConfig({ mcpServers: { [input.name]: input.entry } });

  const path = ratelConfigPath(input.scope, ctx.env);
  const current = await readJson<RatelConfig>(ctx.fs, path);
  if (!current?.mcpServers[input.name]) {
    throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("edit");

  current.mcpServers[input.name] = input.entry;
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
}

export async function removeServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string },
): Promise<EntryMutationResult> {
  const path = ratelConfigPath(input.scope, ctx.env);
  const current = await readJson<RatelConfig>(ctx.fs, path);
  if (!current?.mcpServers[input.name]) {
    throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("remove");

  delete current.mcpServers[input.name];
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
}

export async function undoLatestBackup(ctx: CoreContext): Promise<BackupManifest | null> {
  return restoreLatest(ctx.env, ctx.fs);
}

export async function loadMergedConfig(ctx: CoreContext): Promise<RatelConfig | undefined> {
  const parts: RatelConfig[] = [];
  for (const scope of SCOPES) {
    let path: string;
    try {
      path = ratelConfigPath(scope, ctx.env);
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) continue;
      throw err;
    }
    const cfg = await readJson<RatelConfig>(ctx.fs, path);
    if (cfg) parts.push(cfg);
  }
  if (parts.length === 0) return undefined;
  return mergeConfigs(parts);
}

export async function authorizeServer(
  ctx: CoreContext,
  name?: string,
  opts: { authRunner?: (opts: AuthFlowOptions) => Promise<AuthFlowResult[]> } = {},
): Promise<AuthFlowResult[]> {
  const config = await loadMergedConfig(ctx);
  if (!config || Object.keys(config.mcpServers).length === 0) {
    ctx.log?.("[ratel] no Ratel config found in user/project/local scope; nothing to auth");
    return [];
  }
  if (name && !config.mcpServers[name]) {
    throw new Error(`unknown upstream "${name}" — not present in any Ratel scope`);
  }
  const authOpts: AuthFlowOptions = name ? { name } : {};
  const runner = opts.authRunner ?? (await defaultAuthRunner(config, ctx));
  return runner(authOpts);
}

export interface AgentInteropOptions {
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
}

export interface ImportAgentServersOptions extends AgentInteropOptions {
  conflictStrategy?: ImportConflictStrategy;
}

export async function importAgentServers(
  ctx: CoreContext,
  opts: ImportAgentServersOptions = {},
): Promise<BackupManifest | null> {
  const agentHost = new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  if (!detection.present) {
    ctx.log?.("No supported agent MCP servers found at any scope. Nothing to import.");
    return null;
  }
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const candidates = collectCandidates(agentState);
  if (candidates.length === 0) {
    ctx.log?.(
      `No ${agentState.host.displayName} MCP servers found at any scope. Nothing to import.`,
    );
    return null;
  }

  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await buildAgentImportPlan(inputs, {
    selection: new Set(candidates.map((c) => c.name)),
    conflictStrategy: opts.conflictStrategy ?? "add-missing-only",
  });
  logPlanSummary(ctx, plan, agentState.host.displayName);
  if (plan.ratelChanges.length === 0 && plan.agentChanges.length === 0) return null;

  let latest: BackupManifest | null = null;
  if (plan.ratelChanges.length > 0) {
    latest = await executePlan(plan.ratelChanges, { fs: ctx.fs, env: ctx.env, action: "import" });
  }
  if (plan.agentChanges.length > 0) {
    latest = await executePlan(plan.agentChanges, { fs: ctx.fs, env: ctx.env, action: "import" });
  }
  return latest;
}

export async function linkAgentToRatel(
  ctx: CoreContext,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const agentHost = new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  if (!detection.present) {
    ctx.log?.("No supported agent config found. Nothing to link.");
    return null;
  }
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);

  const ratelKnown = new Set<string>();
  for (const cfg of [inputs.ratelUser, inputs.ratelProject, inputs.ratelLocal]) {
    if (cfg) for (const name of Object.keys(cfg.mcpServers)) ratelKnown.add(name);
  }
  if (ratelKnown.size === 0) {
    ctx.log?.("No Ratel entries found at any scope. Nothing to link.");
    return null;
  }

  const agentKnown = collectAgentNames(agentState);
  const overlap = [...agentKnown].filter((n) => ratelKnown.has(n));
  if (overlap.length === 0) {
    ctx.log?.(
      `No ${agentState.host.displayName} entries match any Ratel entry. Run import to migrate agent entries first.`,
    );
    return null;
  }

  const plan = await buildAgentImportPlan(inputs, { selection: new Set(overlap) });
  if (plan.agentChanges.length === 0) {
    ctx.log?.(`nothing to do (${agentState.host.displayName} already points at Ratel)`);
    return null;
  }

  ctx.log?.(`Rewriting ${plan.agentChanges.length} ${agentState.host.displayName} config file(s).`);
  return executePlan(plan.agentChanges, { fs: ctx.fs, env: ctx.env, action: "link" });
}

async function defaultAuthRunner(config: RatelConfig, ctx: CoreContext) {
  const gateway = await buildGatewayFromConfig(config, { logger: ctx.log });
  return async (opts: AuthFlowOptions) => {
    try {
      return await gateway.runAuthFlow(opts);
    } finally {
      await gateway.close();
    }
  };
}

interface Candidate {
  name: string;
  scope: AgentScope;
}

function collectCandidates(state: AgentHostState): Candidate[] {
  const out: Candidate[] = [];
  for (const scopeState of state.scopes) {
    for (const [name, entry] of Object.entries(scopeState.mcpServers)) {
      if (isRatelGatewayEntry(name, entry)) continue;
      out.push({ name, scope: scopeState.scope });
    }
  }
  return out;
}

function collectAgentNames(state: AgentHostState): Set<string> {
  const out = new Set<string>();
  for (const scope of state.scopes) {
    for (const [name, entry] of Object.entries(scope.mcpServers)) {
      if (!isRatelGatewayEntry(name, entry)) out.add(name);
    }
  }
  return out;
}

async function buildAgentPlanInputs(
  ctx: CoreContext,
  agentHost: AutomaticAgentHostAdapter,
  agentState: AgentHostState,
  opts: AgentInteropOptions,
) {
  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;
  const bin = opts.bin ?? (await resolveBin(opts));

  return {
    agentHost,
    agentState,
    ratelUser: await readJson<RatelConfig>(ctx.fs, ratelUserPath),
    ratelProject: ratelProjectPath ? await readJson<RatelConfig>(ctx.fs, ratelProjectPath) : null,
    ratelLocal: ratelLocalPath ? await readJson<RatelConfig>(ctx.fs, ratelLocalPath) : null,
    bin,
    ratelUserPath,
    ratelProjectPath,
    ratelLocalPath,
    projectRoot: ctx.env.projectRoot,
  };
}

async function resolveBin(opts: AgentInteropOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult ?? whichRatelBin(),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
  });
}

function whichRatelBin(): string | undefined {
  try {
    const out = execSync("which ratel-mcp", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function logPlanSummary(ctx: CoreContext, plan: ImportPlan, agentHostName: string): void {
  const moved = [
    ...plan.summary.movedFromUser,
    ...plan.summary.movedFromProject,
    ...plan.summary.movedFromLocal,
  ];
  const skipped = plan.summary.skipped.length;
  const conflicts = plan.summary.conflicts.length;
  ctx.log?.(
    `Import plan for ${agentHostName}: ${moved.length} moved, ${skipped} skipped, ${conflicts} conflict(s).`,
  );
}
