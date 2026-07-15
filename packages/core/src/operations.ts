import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  AgentHostAdapter,
  AgentHostContext,
  AgentHostDetection,
  AgentHostState,
  AgentScope,
  AgentScopeState,
  SupportedAgentHostKind,
} from "./agent-host/index.js";
import {
  AutomaticAgentHostAdapter,
  isSupportedAgentHostKind,
  NamedAgentHostAdapter,
  SUPPORTED_AGENT_HOSTS,
} from "./agent-host/index.js";
import {
  buildAgentHostRatelPluginLinkChanges,
  findAgentHostRatelPluginConnection,
  getAgentHostRatelConnection,
  pluginLinkNoOpMessage,
  type RatelConnectionState,
} from "./agent-host/ratel-connection.js";
import { type BackupFs, type BackupManifest, listBackups, startBackup } from "./backup.js";
import { isRatelGatewayEntry } from "./gateway-entry.js";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "./hierarchy.js";
import {
  buildAgentImportPlan,
  buildAgentLinkPlan,
  type FileChange,
  type ImportConflictStrategy,
  type ImportPlan,
} from "./import-plan.js";
import { type JsonFs, nodeFs, readJson, writeJson } from "./io.js";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  buildGatewayFromConfig,
  mergeConfigs,
  parseConfig,
  type RatelConfig,
  type RatelConfigDocument,
  type ServerEntry,
} from "./lib/index.js";
import { createLocalGitExcludeManager, type LocalGitExcludeManager } from "./local-git-exclude.js";
import { locateRatelBin, type ResolvedBin, whichRatelBin } from "./locate-bin.js";
import type { MutationEngine } from "./mutation-engine.js";
import { executePlanTransactionally, type PlanExecutor } from "./plan-exec.js";
import { assertSafeProjectControlPath } from "./project-path-safety.js";
import { type ClaudeCodeStatuslineState, getClaudeCodeStatuslineState } from "./statusline.js";
import { readLatestToolTokenEstimates, type ServerToolTokenEstimate } from "./telemetry.js";

export type CoreFs = JsonFs & BackupFs;

export interface CoreContext {
  env: {
    homeDir: string;
    projectRoot?: string;
  };
  fs: CoreFs;
  log?: (message: string) => void;
  /** Explicit compatibility seam for embedders using a non-native filesystem. */
  planExecutor?: PlanExecutor;
}

export type AuthStatus = "n/a" | "needs auth" | "expired" | "ok" | "unsupported";

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
  toolTokenEstimatesByServer: Record<string, ServerToolTokenEstimate>;
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
  const stored = await readJson<{
    tokens?: { access_token?: string };
    expires_at?: number;
    unsupported?: { reason?: string; detected_at?: string };
  }>(ctx.fs, path);
  if (!stored?.tokens?.access_token) {
    if (stored?.unsupported?.reason) return "unsupported";
    return "needs auth";
  }
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
    const cfg = parseConfig((await readJson<RatelConfigDocument>(ctx.fs, path)) ?? {});
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
    toolTokenEstimatesByServer: (await readLatestToolTokenEstimates(ctx)).byServer,
  };
}

export async function addServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string; entry: ServerEntry; overwrite?: boolean },
): Promise<EntryMutationResult> {
  parseConfig({ mcpServers: { [input.name]: input.entry } });

  const path = ratelConfigPath(input.scope, ctx.env);
  const current = (await readJson<RatelConfigDocument>(ctx.fs, path)) ?? {};
  parseConfig(current);
  current.mcpServers ??= {};
  const mcpServers = current.mcpServers;
  if (mcpServers[input.name] && !input.overwrite) {
    throw new Error(`entry "${input.name}" already exists at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("add");

  mcpServers[input.name] = input.entry;
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
}

export async function editServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string; entry: ServerEntry },
): Promise<EntryMutationResult> {
  parseConfig({ mcpServers: { [input.name]: input.entry } });

  const path = ratelConfigPath(input.scope, ctx.env);
  const current = await readJson<RatelConfigDocument>(ctx.fs, path);
  if (!current) throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  parseConfig(current);
  current.mcpServers ??= {};
  const mcpServers = current.mcpServers;
  if (!mcpServers[input.name]) {
    throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("edit");

  mcpServers[input.name] = input.entry;
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
}

export async function removeServerEntry(
  ctx: CoreContext,
  input: { scope: RatelScope; name: string },
): Promise<EntryMutationResult> {
  const path = ratelConfigPath(input.scope, ctx.env);
  const current = await readJson<RatelConfigDocument>(ctx.fs, path);
  if (!current) throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  parseConfig(current);
  current.mcpServers ??= {};
  const mcpServers = current.mcpServers;
  if (!mcpServers[input.name]) {
    throw new Error(`entry "${input.name}" not found at scope ${input.scope}`);
  }

  const session = startBackup(ctx.env, ctx.fs);
  await session.capture(path);
  const manifest = await session.finalize("remove");

  delete mcpServers[input.name];
  await writeJson(ctx.fs, path, current);
  return { name: input.name, scope: input.scope, path, manifest };
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
    const cfg = await readJson<RatelConfigDocument>(ctx.fs, path);
    if (cfg) parts.push(parseConfig(cfg));
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
  mutationEngine?: MutationEngine;
  localGitExcludeManager?: LocalGitExcludeManager;
}

export interface ImportAgentServersOptions extends AgentInteropOptions {
  conflictStrategy?: ImportConflictStrategy;
}

export type AgentPosture = "unavailable" | "empty" | "not-linked" | "ratel-only" | "mixed";

export interface AgentScopePosture {
  scope: AgentScope;
  displayName: string;
  path: string;
  available: boolean;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames: string[];
  ratelEntryNames: string[];
}

export interface DetectedAgentHostSummary {
  kind: SupportedAgentHostKind;
  displayName: string;
  detection: AgentHostDetection;
  connection: RatelConnectionState;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames: string[];
  ratelEntryNames: string[];
  missingRatelEntryNames: string[];
  scopes: AgentScopePosture[];
  statusline?: ClaudeCodeStatuslineState;
}

export interface AgentHostsState {
  hosts: DetectedAgentHostSummary[];
}

export interface AgentCandidate {
  name: string;
  scope: AgentScope;
  entry: ServerEntry;
}

export interface AgentPlanStageHashes {
  ratel: string;
  agent: string;
}

export interface AgentPlanPreview {
  flow: "import" | "link";
  host: DetectedAgentHostSummary;
  candidates: AgentCandidate[];
  selected: string[];
  plan: ImportPlan;
  stageHashes: AgentPlanStageHashes;
  emptyReason: string | null;
}

export interface PreviewAgentImportInput {
  hostKind: SupportedAgentHostKind;
  selection?: string[];
  conflictStrategy?: ImportConflictStrategy;
  replaceConflicts?: string[];
}

export interface PreviewAgentLinkInput {
  hostKind: SupportedAgentHostKind;
}

export interface ApplyAgentImportInput extends PreviewAgentImportInput {
  planHash: string;
}

export interface ApplyCombinedAgentImportInput extends PreviewAgentImportInput {
  stageHashes: AgentPlanStageHashes;
}

export interface ApplyAgentLinkInput extends PreviewAgentLinkInput {
  planHash: string;
}

export interface RemoveAgentRatelMcpFallbackInput {
  hostKind: SupportedAgentHostKind;
}

export class AgentPlanConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "AGENT_PLAN_STALE";

  constructor() {
    super("preview is stale; scan again and review the latest changes before applying");
    this.name = "AgentPlanConflictError";
  }
}

export async function getAgentHostsState(ctx: CoreContext): Promise<AgentHostsState> {
  const hosts: DetectedAgentHostSummary[] = [];
  const ratelKnownNames = collectRatelKnownNames(await readAllRatelConfigs(ctx));
  for (const host of SUPPORTED_AGENT_HOSTS) {
    const adapter = new NamedAgentHostAdapter(host.kind);
    const detection = await adapter.detect(agentHostContext(ctx));
    let state: AgentHostState | null = null;
    try {
      state = await adapter.read(agentHostContext(ctx));
    } catch (err) {
      detection.warnings.push(`Failed to read ${host.displayName}: ${(err as Error).message}`);
    }
    const summary = await summarizeDetectedAgentHost(
      host.kind,
      host.displayName,
      detection,
      state,
      ctx,
      ratelKnownNames,
    );
    if (host.kind === "claude-code") {
      try {
        summary.statusline = await getClaudeCodeStatuslineState(ctx);
      } catch (err) {
        detection.warnings.push(
          `Failed to read Claude Code statusline state: ${(err as Error).message}`,
        );
      }
    }
    hosts.push(summary);
  }
  return { hosts };
}

export async function previewAgentImport(
  ctx: CoreContext,
  input: PreviewAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<AgentPlanPreview> {
  const hostKind = assertSupportedAgentHostKind(input.hostKind);
  const agentHost = new NamedAgentHostAdapter(hostKind);
  const detection = await agentHost.detect(agentHostContext(ctx));
  const agentState = await agentHost.read(agentHostContext(ctx));
  const host = await summarizeDetectedAgentHost(
    hostKind,
    agentState.host.displayName,
    detection,
    agentState,
    ctx,
    collectRatelKnownNames(await readAllRatelConfigs(ctx)),
  );
  const candidates = collectAgentCandidates(agentState);
  const selected = normalizeAgentSelection(input.selection, candidates);

  if (candidates.length === 0 || selected.length === 0) {
    const plan = emptyAgentPlan(input.conflictStrategy ?? "add-missing-only");
    return toAgentPlanPreview("import", host, candidates, selected, plan, input, {
      emptyReason:
        candidates.length === 0
          ? `No native ${agentState.host.displayName} MCP entries found.`
          : "No entries selected.",
    });
  }

  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await withLocalGitExcludeChange(
    ctx,
    await buildAgentImportPlan(inputs, {
      selection: new Set(selected),
      conflictStrategy: input.conflictStrategy ?? "add-missing-only",
      replaceConflicts: input.replaceConflicts ?? [],
      installGateway: host.connection.explicit,
    }),
    opts,
  );
  return toAgentPlanPreview("import", host, candidates, selected, plan, input);
}

export async function previewAgentLink(
  ctx: CoreContext,
  input: PreviewAgentLinkInput,
  opts: AgentInteropOptions = {},
): Promise<AgentPlanPreview> {
  const hostKind = assertSupportedAgentHostKind(input.hostKind);
  const agentHost = new NamedAgentHostAdapter(hostKind);
  const detection = await agentHost.detect(agentHostContext(ctx));
  const agentState = await agentHost.read(agentHostContext(ctx));
  const host = await summarizeDetectedAgentHost(
    hostKind,
    agentState.host.displayName,
    detection,
    agentState,
    ctx,
    collectRatelKnownNames(await readAllRatelConfigs(ctx)),
  );
  if (host.connection.plugin) {
    return toAgentPlanPreview("link", host, [], [], emptyAgentPlan("add-missing-only"), input, {
      emptyReason: pluginLinkNoOpMessage(host.displayName, host.connection),
    });
  }
  const pluginChanges = buildAgentHostRatelPluginLinkChanges(hostKind, agentState, host.connection);
  if (pluginChanges.length > 0) {
    const plan = emptyAgentPlan("add-missing-only");
    plan.agentChanges = pluginChanges;
    return toAgentPlanPreview("link", host, [], [], plan, input);
  }
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await buildAgentLinkPlan(inputs);
  return toAgentPlanPreview("link", host, [], [], plan, input, {
    emptyReason:
      plan.agentChanges.length === 0
        ? `${agentState.host.displayName} already has the Ratel gateway configured for the available Ratel scopes.`
        : null,
  });
}

export async function applyAgentImportRatel(
  ctx: CoreContext,
  input: ApplyAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentImport(ctx, input, opts);
  assertPlanHash(input.planHash, preview.stageHashes.ratel);
  if (preview.plan.ratelChanges.length === 0) return null;
  return executeAgentFileChanges(ctx, preview.plan.ratelChanges, "import", opts.mutationEngine);
}

export async function applyAgentImportAgent(
  ctx: CoreContext,
  input: ApplyAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentImport(ctx, input, opts);
  assertPlanHash(input.planHash, preview.stageHashes.agent);
  if (preview.plan.agentChanges.length === 0) return null;
  return executeAgentFileChanges(ctx, preview.plan.agentChanges, "import", opts.mutationEngine);
}

/** Apply the Ratel document changes and native-agent rewrite as one recoverable transaction. */
export async function applyCombinedAgentImport(
  ctx: CoreContext,
  input: ApplyCombinedAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentImport(ctx, input, opts);
  assertPlanHash(input.stageHashes.ratel, preview.stageHashes.ratel);
  assertPlanHash(input.stageHashes.agent, preview.stageHashes.agent);
  const changes = [...preview.plan.ratelChanges, ...preview.plan.agentChanges];
  if (changes.length === 0) return null;
  return executeAgentFileChanges(ctx, changes, "import", opts.mutationEngine);
}

export async function applyAgentLink(
  ctx: CoreContext,
  input: ApplyAgentLinkInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentLink(ctx, input, opts);
  assertPlanHash(input.planHash, preview.stageHashes.agent);
  if (preview.plan.agentChanges.length === 0) return null;
  return executeAgentFileChanges(ctx, preview.plan.agentChanges, "link", opts.mutationEngine);
}

export async function importAgentServers(
  ctx: CoreContext,
  opts: ImportAgentServersOptions = {},
): Promise<BackupManifest | null> {
  const agentHost = new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect(agentHostContext(ctx));
  if (!detection.present) {
    ctx.log?.("No supported agent MCP servers found at any scope. Nothing to import.");
    return null;
  }
  const agentState = await agentHost.read(agentHostContext(ctx));
  const candidates = collectCandidates(agentState);
  if (candidates.length === 0) {
    ctx.log?.(
      `No ${agentState.host.displayName} MCP servers found at any scope. Nothing to import.`,
    );
    return null;
  }

  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await withLocalGitExcludeChange(
    ctx,
    await buildAgentImportPlan(inputs, {
      selection: new Set(candidates.map((c) => c.name)),
      conflictStrategy: opts.conflictStrategy ?? "add-missing-only",
    }),
    opts,
  );
  logPlanSummary(ctx, plan, agentState.host.displayName);
  if (plan.ratelChanges.length === 0 && plan.agentChanges.length === 0) return null;

  return executeAgentFileChanges(
    ctx,
    [...plan.ratelChanges, ...plan.agentChanges],
    "import",
    opts.mutationEngine,
  );
}

export async function linkAgentToRatel(
  ctx: CoreContext,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const agentHost = new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect(agentHostContext(ctx));
  if (!detection.present) {
    const pluginHost = await findAgentHostRatelPluginConnection(ctx);
    if (pluginHost) {
      ctx.log?.(pluginLinkNoOpMessage(pluginHost.state.host.displayName, pluginHost.connection));
      return null;
    }
    ctx.log?.("No supported agent config found. Nothing to link.");
    return null;
  }
  const agentState = await agentHost.read(agentHostContext(ctx));
  const hostKind = assertSupportedAgentHostKind(agentState.host.kind);
  const connection = await getAgentHostRatelConnection(hostKind, agentState, ctx);
  if (connection.plugin) {
    ctx.log?.(pluginLinkNoOpMessage(agentState.host.displayName, connection));
    return null;
  }
  const pluginChanges = buildAgentHostRatelPluginLinkChanges(hostKind, agentState, connection);
  if (pluginChanges.length > 0) {
    ctx.log?.(`Re-enabling the Ratel Local plugin MCP server in ${agentState.host.displayName}.`);
    return executeAgentFileChanges(ctx, pluginChanges, "link", opts.mutationEngine);
  }
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);

  const plan = await buildAgentLinkPlan(inputs);
  if (plan.agentChanges.length === 0) {
    ctx.log?.(`nothing to do (${agentState.host.displayName} already points at Ratel)`);
    return null;
  }

  ctx.log?.(`Rewriting ${plan.agentChanges.length} ${agentState.host.displayName} config file(s).`);
  return executeAgentFileChanges(ctx, plan.agentChanges, "link", opts.mutationEngine);
}

function executeAgentFileChanges(
  ctx: CoreContext,
  changes: readonly FileChange[],
  action: BackupManifest["action"],
  mutationEngine?: MutationEngine,
): Promise<BackupManifest> {
  return (ctx.planExecutor ?? executePlanTransactionally)(changes, {
    fs: ctx.fs,
    env: ctx.env,
    action,
    ...(mutationEngine ? { mutationEngine } : {}),
  });
}

export async function removeAgentRatelMcpFallback(
  ctx: CoreContext,
  input: RemoveAgentRatelMcpFallbackInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const hostKind = assertSupportedAgentHostKind(input.hostKind);
  const agentHost = new NamedAgentHostAdapter(hostKind);
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const removeEntriesByScope = new Map<AgentScope, Set<string>>();

  for (const scope of agentState.scopes) {
    const names = Object.entries(scope.mcpServers)
      .filter(([name, entry]) => isRatelGatewayEntry(name, entry))
      .map(([name]) => name);
    if (names.length > 0) removeEntriesByScope.set(scope.scope, new Set(names));
  }

  if (removeEntriesByScope.size === 0) {
    ctx.log?.(`${agentState.host.displayName} has no explicit Ratel MCP fallback to remove.`);
    return null;
  }

  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const hostChanges = await agentHost.planChanges({
    state: agentState,
    bin: inputs.bin,
    ratelConfigPaths: {
      user: inputs.ratelUserPath,
      ...(inputs.ratelProjectPath ? { project: inputs.ratelProjectPath } : {}),
      ...(inputs.ratelLocalPath ? { local: inputs.ratelLocalPath } : {}),
    },
    removeEntriesByScope,
  });
  if (hostChanges.changes.length === 0) return null;

  ctx.log?.(
    `Removing ${hostChanges.summary.removedNativeEntries.length} explicit Ratel MCP fallback entr${
      hostChanges.summary.removedNativeEntries.length === 1 ? "y" : "ies"
    } from ${agentState.host.displayName}.`,
  );
  return executeAgentFileChanges(ctx, hostChanges.changes, "link", opts.mutationEngine);
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

function assertSupportedAgentHostKind(value: unknown): SupportedAgentHostKind {
  if (isSupportedAgentHostKind(value)) return value;
  throw new Error(`agent host must be one of claude-code|codex, got ${JSON.stringify(value)}`);
}

async function summarizeDetectedAgentHost(
  kind: SupportedAgentHostKind,
  displayName: string,
  detection: AgentHostDetection,
  state: AgentHostState | null,
  ctx: Pick<CoreContext, "env" | "fs">,
  ratelKnownNames: ReadonlySet<string> = new Set(),
): Promise<DetectedAgentHostSummary> {
  const scopes = state?.scopes.map(summarizeAgentScope) ?? [];
  const nativeEntryCount = scopes.reduce((sum, scope) => sum + scope.nativeEntryCount, 0);
  const ratelEntryCount = scopes.reduce((sum, scope) => sum + scope.ratelEntryCount, 0);
  const entryCount = nativeEntryCount + ratelEntryCount;
  const nativeEntryNames = [...new Set(scopes.flatMap((scope) => scope.nativeEntryNames))].sort();
  const ratelEntryNames = [...new Set(scopes.flatMap((scope) => scope.ratelEntryNames))].sort();
  const connection = await getAgentHostRatelConnection(kind, state, ctx, detection.warnings);
  return {
    kind,
    displayName,
    detection,
    connection,
    posture:
      detection.present || connection.plugin
        ? classifyPosture({
            available: true,
            nativeEntryCount,
            linked: connection.linked,
          })
        : "unavailable",
    nativeEntryCount,
    ratelEntryCount,
    entryCount,
    nativeEntryNames,
    ratelEntryNames,
    missingRatelEntryNames: nativeEntryNames.filter((name) => !ratelKnownNames.has(name)),
    scopes,
  };
}

function summarizeAgentScope(scope: AgentScopeState): AgentScopePosture {
  let nativeEntryCount = 0;
  let ratelEntryCount = 0;
  const nativeEntryNames: string[] = [];
  const ratelEntryNames: string[] = [];
  for (const [name, entry] of Object.entries(scope.mcpServers)) {
    if (isRatelGatewayEntry(name, entry)) {
      ratelEntryCount++;
      ratelEntryNames.push(name);
    } else {
      nativeEntryCount++;
      nativeEntryNames.push(name);
    }
  }
  return {
    scope: scope.scope,
    displayName: scope.displayName,
    path: scope.path,
    available: scope.available,
    posture: classifyPosture({
      available: scope.available,
      nativeEntryCount,
      linked: ratelEntryCount > 0,
    }),
    nativeEntryCount,
    ratelEntryCount,
    entryCount: nativeEntryCount + ratelEntryCount,
    nativeEntryNames: nativeEntryNames.sort(),
    ratelEntryNames: ratelEntryNames.sort(),
  };
}

function classifyPosture(input: {
  available: boolean;
  nativeEntryCount: number;
  linked: boolean;
}): AgentPosture {
  if (!input.available) return "unavailable";
  if (input.nativeEntryCount === 0 && !input.linked) return "empty";
  if (input.nativeEntryCount === 0) return "ratel-only";
  if (!input.linked) return "not-linked";
  return "mixed";
}

function collectAgentCandidates(state: AgentHostState): AgentCandidate[] {
  const out: AgentCandidate[] = [];
  for (const scopeState of state.scopes) {
    for (const [name, entry] of Object.entries(scopeState.mcpServers)) {
      if (isRatelGatewayEntry(name, entry)) continue;
      out.push({ name, scope: scopeState.scope, entry });
    }
  }
  return out;
}

function normalizeAgentSelection(
  selection: readonly string[] | undefined,
  candidates: readonly AgentCandidate[],
): string[] {
  const available = new Set(candidates.map((candidate) => candidate.name));
  if (!selection) return [...available].sort();
  return [...new Set(selection)].filter((name) => available.has(name)).sort();
}

function collectRatelKnownNames(configs: readonly (RatelConfig | null)[]): Set<string> {
  const out = new Set<string>();
  for (const cfg of configs) {
    if (!cfg) continue;
    for (const name of Object.keys(cfg.mcpServers)) out.add(name);
  }
  return out;
}

async function withLocalGitExcludeChange(
  ctx: CoreContext,
  plan: ImportPlan,
  opts: AgentInteropOptions,
): Promise<ImportPlan> {
  if (!ctx.env.projectRoot) return plan;
  const localConfigPath = ratelConfigPath("local", ctx.env);
  if (!plan.ratelChanges.some(({ path }) => path === localConfigPath)) return plan;
  const manager =
    opts.localGitExcludeManager ?? (ctx.fs === nodeFs ? createLocalGitExcludeManager() : undefined);
  if (!manager) return plan;
  const preview = await manager.preview(ctx.env.projectRoot);
  if (!preview.changed) return plan;
  if (plan.ratelChanges.some(({ path }) => path === preview.excludePath)) {
    throw new Error(`import plan already writes Git exclude file ${preview.excludePath}`);
  }
  return {
    ...plan,
    ratelChanges: [
      ...plan.ratelChanges,
      {
        kind: "write",
        path: preview.excludePath,
        before: preview.currentContents,
        after: preview.contents,
      },
    ],
  };
}

async function readAllRatelConfigs(ctx: CoreContext): Promise<(RatelConfig | null)[]> {
  const configs: (RatelConfig | null)[] = [];
  for (const scope of SCOPES) {
    try {
      configs.push(await readRatelConfig(ctx, ratelConfigPath(scope, ctx.env), scope !== "user"));
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) {
        configs.push(null);
        continue;
      }
      throw err;
    }
  }
  return configs;
}

function emptyAgentPlan(conflictStrategy: ImportConflictStrategy): ImportPlan {
  return {
    ratelChanges: [],
    agentChanges: [],
    summary: {
      movedFromUser: [],
      movedFromProject: [],
      movedFromLocal: [],
      replacedFromUser: [],
      replacedFromProject: [],
      replacedFromLocal: [],
      skipped: [],
      conflicts: [],
      conflictStrategy,
      ratelEntryArgsByScope: {},
      overwrittenRatelEntries: [],
    },
  };
}

function toAgentPlanPreview(
  flow: "import" | "link",
  host: DetectedAgentHostSummary,
  candidates: AgentCandidate[],
  selected: string[],
  plan: ImportPlan,
  input: PreviewAgentImportInput | PreviewAgentLinkInput,
  opts: { emptyReason?: string | null } = {},
): AgentPlanPreview {
  return {
    flow,
    host,
    candidates,
    selected,
    plan,
    stageHashes: {
      ratel: hashPlanStage(
        flow,
        "ratel",
        host.kind,
        { ...input, selection: selected },
        plan.ratelChanges,
      ),
      agent: hashPlanStage(
        flow,
        "agent",
        host.kind,
        { ...input, selection: selected },
        plan.agentChanges,
      ),
    },
    emptyReason:
      opts.emptyReason ?? emptyReasonForPreview(flow, host.displayName, candidates, selected, plan),
  };
}

function emptyReasonForPreview(
  flow: "import" | "link",
  hostName: string,
  candidates: readonly AgentCandidate[],
  selected: readonly string[],
  plan: ImportPlan,
): string | null {
  if (plan.ratelChanges.length > 0 || plan.agentChanges.length > 0) return null;
  if (candidates.length === 0) {
    return flow === "import"
      ? `No ${hostName} MCP servers found at any scope.`
      : `No ${hostName} config changes needed.`;
  }
  if (selected.length === 0) return "No entries selected.";
  return "No file changes needed.";
}

function hashPlanStage(
  flow: "import" | "link",
  stage: "ratel" | "agent",
  hostKind: SupportedAgentHostKind,
  input: PreviewAgentImportInput | PreviewAgentLinkInput,
  changes: readonly FileChange[],
): string {
  const selection = "selection" in input ? (input.selection ?? []) : [];
  const payload = {
    flow,
    stage,
    hostKind,
    selection: [...new Set(selection)].sort(),
    conflictStrategy:
      "conflictStrategy" in input ? (input.conflictStrategy ?? "add-missing-only") : undefined,
    replaceConflicts:
      "replaceConflicts" in input ? [...new Set(input.replaceConflicts ?? [])].sort() : [],
    changes,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function assertPlanHash(received: string, expected: string): void {
  if (received !== expected) {
    throw new AgentPlanConflictError();
  }
}

async function buildAgentPlanInputs(
  ctx: CoreContext,
  agentHost: AgentHostAdapter,
  agentState: AgentHostState,
  opts: AgentInteropOptions,
) {
  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;
  const bin = opts.bin ?? (await resolveBin(opts));
  const ratelUser = await withImplicitUserSkillDirectory(
    ctx,
    await readRatelConfig(ctx, ratelUserPath),
  );

  return {
    agentHost,
    agentState,
    ratelUser,
    ratelProject: ratelProjectPath ? await readRatelConfig(ctx, ratelProjectPath, true) : null,
    ratelLocal: ratelLocalPath ? await readRatelConfig(ctx, ratelLocalPath, true) : null,
    bin,
    ratelUserPath,
    ratelProjectPath,
    ratelLocalPath,
    projectRoot: ctx.env.projectRoot,
  };
}

async function withImplicitUserSkillDirectory(
  ctx: CoreContext,
  config: RatelConfig | null,
): Promise<RatelConfig | null> {
  if (config?.skills?.dirs !== undefined) return config;
  const defaultDir = join(ctx.env.homeDir, ".ratel", "skills");
  const entries = await ctx.fs.list(defaultDir);
  const hasSkill = (
    await Promise.all(entries.map((entry) => ctx.fs.exists(join(defaultDir, entry, "SKILL.md"))))
  ).some(Boolean);
  if (!hasSkill) return config;
  return {
    ...(config ?? parseConfig({})),
    skills: { ...(config?.skills ?? {}), dirs: [defaultDir] },
  };
}

async function readRatelConfig(
  ctx: CoreContext,
  path: string,
  projectScoped = false,
): Promise<RatelConfig | null> {
  if (projectScoped && ctx.env.projectRoot && ctx.fs === nodeFs) {
    await assertSafeProjectControlPath(ctx.env.projectRoot, path);
  }
  const document = await readJson<RatelConfigDocument>(ctx.fs, path);
  if (!document) return null;
  const normalized = parseConfig(document);
  return {
    ...document,
    mcpServers: normalized.mcpServers,
    ...(document.skills !== undefined ? { skills: document.skills } : {}),
  };
}

function agentHostContext(ctx: CoreContext): AgentHostContext {
  return {
    env: ctx.env,
    fs: ctx.fs,
    ...(ctx.env.projectRoot && ctx.fs === nodeFs
      ? { assertProjectPath: assertSafeProjectControlPath }
      : {}),
  };
}

async function resolveBin(opts: AgentInteropOptions): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_LOCAL_BIN,
    whichResult: opts.whichResult ?? whichRatelBin(),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
  });
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
