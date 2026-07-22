import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  isSupportedAgentHostKind,
  NamedAgentHostAdapter,
  SUPPORTED_AGENT_HOSTS,
} from "./agent-host/index.js";
import {
  buildAgentHostRatelPluginLinkChanges,
  getAgentHostRatelConnection,
  pluginLinkNoOpMessage,
  type RatelConnectionState,
} from "./agent-host/ratel-connection.js";
import { type BackupFs, type BackupManifest, listBackups, startBackup } from "./backup.js";
import { isRatelGatewayEntry } from "./gateway-entry.js";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "./hierarchy.js";
import {
  type AgentImportDraft,
  buildAgentAgentImportDraft,
  buildAgentLinkPlan,
  type ImportConflictStrategy,
  type PlannedFileWrite,
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
import {
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  type PreparedMutation,
} from "./mutation-engine.js";
import type {
  PreparedChange,
  PreparedChangeCommit,
  PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";
import { assertSafeProjectControlPath } from "./project-path-safety.js";
import { projectIdFromCanonicalRoot } from "./project-registry.js";
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
  localGitExcludeManager?: LocalGitExcludeManager;
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

interface PlannedAgentChange {
  flow: "import" | "link";
  host: DetectedAgentHostSummary;
  candidates: AgentCandidate[];
  selected: string[];
  plan: AgentImportDraft;
  emptyReason: string | null;
}

export interface AgentFileDiff {
  path: string;
  before: string | null;
  after: string;
}

export interface AgentChangeReview {
  flow: "import" | "link";
  host: DetectedAgentHostSummary;
  candidates: AgentCandidate[];
  selected: string[];
  plan: {
    ratelChanges: AgentFileDiff[];
    agentChanges: AgentFileDiff[];
    summary: AgentImportDraft["summary"];
  };
  emptyReason: string | null;
  pluginInstallRecommended: boolean;
}

export interface AgentChangeResult {
  flow: "import" | "link";
  hostKind: SupportedAgentHostKind;
  mode?: "plugin" | "config" | "mcp-fallback";
  log?: string[];
}

export type AgentPreparedChange = PreparedChange<AgentChangeReview>;
export type AgentChangeCommit = PreparedChangeCommit<AgentChangeResult>;

export interface PrepareAgentImportInput {
  hostKind: SupportedAgentHostKind;
  selection?: string[];
  conflictStrategy?: ImportConflictStrategy;
  replaceConflicts?: string[];
}

export interface PrepareAgentLinkInput {
  hostKind: SupportedAgentHostKind;
}

export interface RemoveAgentRatelMcpFallbackInput {
  hostKind: SupportedAgentHostKind;
}

export interface AgentFallbackCleanupReview {
  hostKind: SupportedAgentHostKind;
  removedEntries: number;
  files: AgentFileDiff[];
}

export interface AgentFallbackCleanupResult {
  hostKind: SupportedAgentHostKind;
  removedEntries: number;
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

async function planAgentImport(
  ctx: CoreContext,
  input: PrepareAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<PlannedAgentChange> {
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
    return toAgentPlanPreview("import", host, candidates, selected, plan, {
      emptyReason:
        candidates.length === 0
          ? `No native ${agentState.host.displayName} MCP entries found.`
          : "No entries selected.",
    });
  }

  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await withLocalGitExcludeChange(
    ctx,
    await buildAgentAgentImportDraft(inputs, {
      selection: new Set(selected),
      conflictStrategy: input.conflictStrategy ?? "add-missing-only",
      replaceConflicts: input.replaceConflicts ?? [],
      installGateway: host.connection.explicit,
    }),
    opts,
  );
  return toAgentPlanPreview("import", host, candidates, selected, plan);
}

async function planAgentLink(
  ctx: CoreContext,
  input: PrepareAgentLinkInput,
  opts: AgentInteropOptions = {},
): Promise<PlannedAgentChange> {
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
    return toAgentPlanPreview("link", host, [], [], emptyAgentPlan("add-missing-only"), {
      emptyReason: pluginLinkNoOpMessage(host.displayName, host.connection),
    });
  }
  const pluginChanges = buildAgentHostRatelPluginLinkChanges(hostKind, agentState, host.connection);
  if (pluginChanges.length > 0) {
    const plan = emptyAgentPlan("add-missing-only");
    plan.agentChanges = pluginChanges;
    return toAgentPlanPreview("link", host, [], [], plan);
  }
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const plan = await buildAgentLinkPlan(inputs);
  return toAgentPlanPreview("link", host, [], [], plan, {
    emptyReason:
      plan.agentChanges.length === 0
        ? `${agentState.host.displayName} already has the Ratel gateway configured for the available Ratel scopes.`
        : null,
  });
}

export async function prepareAgentImport(
  ctx: CoreContext,
  input: PrepareAgentImportInput,
  opts: AgentInteropOptions & { preparedChanges: PreparedChangeCoordinator },
): Promise<AgentPreparedChange> {
  const planned = await planAgentImport(ctx, input, opts);
  return preparePlannedAgentChange(ctx, planned, opts.preparedChanges, "import");
}

export async function prepareAgentLink(
  ctx: CoreContext,
  input: PrepareAgentLinkInput,
  opts: AgentInteropOptions & {
    preparedChanges: PreparedChangeCoordinator;
    beforeCommit?: () => Promise<
      | { action: "commit"; result?: AgentChangeResult }
      | { action: "cancel"; result?: AgentChangeResult }
    >;
  },
): Promise<AgentPreparedChange> {
  const planned = await planAgentLink(ctx, input, opts);
  return preparePlannedAgentChange(ctx, planned, opts.preparedChanges, "link", opts.beforeCommit);
}

async function preparePlannedAgentChange(
  ctx: CoreContext,
  planned: PlannedAgentChange,
  preparedChanges: PreparedChangeCoordinator,
  action: "import" | "link",
  beforeCommit?: () => Promise<
    | { action: "commit"; result?: AgentChangeResult }
    | { action: "cancel"; result?: AgentChangeResult }
  >,
): Promise<AgentPreparedChange> {
  const changes = [...planned.plan.ratelChanges, ...planned.plan.agentChanges];
  const projectPaths = new Map<string, string>();
  if (ctx.env.projectRoot) {
    for (const change of changes) {
      if (isWithinProject(ctx.env.projectRoot, change.path)) {
        projectPaths.set(change.path, ctx.env.projectRoot);
      }
    }
  }
  return preparedChanges.prepare({
    kind: `agent.${action}`,
    operations: changes.map((change) => ({
      kind: "replace-file" as const,
      path: change.path,
      contents: change.after,
    })),
    affectedContexts: affectedContextsForAgentChange(ctx),
    buildPreview: (mutation) => {
      assertAgentChangeSnapshots(changes, mutation);
      return {
        flow: planned.flow,
        host: planned.host,
        candidates: planned.candidates,
        selected: planned.selected,
        plan: {
          ratelChanges: planned.plan.ratelChanges.map(toAgentFileDiff),
          agentChanges: planned.plan.agentChanges.map(toAgentFileDiff),
          summary: planned.plan.summary,
        },
        emptyReason: planned.emptyReason,
        pluginInstallRecommended:
          action === "link" &&
          planned.host.connection.kind === "none" &&
          planned.plan.agentChanges.length > 0,
      };
    },
    captureBackup:
      changes.length === 0
        ? undefined
        : async () => {
            const session = startBackup(ctx.env, ctx.fs);
            for (const change of changes) await session.capture(change.path);
            return session.finalize(action);
          },
    invariants: {
      precondition: async () => {
        for (const [path, projectRoot] of projectPaths) {
          await assertSafeProjectControlPath(projectRoot, path);
        }
      },
      operationPrecondition: async (operation) => {
        const projectRoot = projectPaths.get(operation.path);
        if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
      },
    },
    beforeCommit:
      action === "link" &&
      planned.host.connection.kind === "none" &&
      planned.plan.agentChanges.length > 0
        ? beforeCommit
        : undefined,
    result: {
      flow: action,
      hostKind: planned.host.kind,
      mode:
        action === "link" &&
        planned.host.connection.kind === "none" &&
        planned.plan.agentChanges.length > 0
          ? "mcp-fallback"
          : "config",
    },
  });
}

function assertAgentChangeSnapshots(
  changes: readonly PlannedFileWrite[],
  mutation: Readonly<PreparedMutation>,
): void {
  for (const change of changes) {
    const expected =
      change.before === null ? MISSING_DOCUMENT_REVISION : documentRevision(change.before);
    const actual = mutation.baseRevisions[change.path];
    if (actual !== expected) {
      throw new MutationConflictError(
        "revision_conflict",
        `document changed while preparing agent change: ${change.path}`,
        change.path,
        expected,
        actual,
      );
    }
  }
}

function toAgentFileDiff(change: PlannedFileWrite): AgentFileDiff {
  return { path: change.path, before: change.before, after: change.after };
}

function affectedContextsForAgentChange(ctx: CoreContext) {
  return [
    { kind: "global" as const },
    ...(ctx.env.projectRoot
      ? [
          {
            kind: "project" as const,
            projectId: projectIdFromCanonicalRoot(ctx.env.projectRoot),
          },
        ]
      : []),
  ];
}

function isWithinProject(projectRoot: string, path: string): boolean {
  const fromRoot = relative(resolve(projectRoot), resolve(path));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

export async function prepareAgentRatelMcpFallbackRemoval(
  ctx: CoreContext,
  input: RemoveAgentRatelMcpFallbackInput,
  opts: AgentInteropOptions & { preparedChanges: PreparedChangeCoordinator },
): Promise<PreparedChange<AgentFallbackCleanupReview>> {
  const hostKind = assertSupportedAgentHostKind(input.hostKind);
  const agentHost = new NamedAgentHostAdapter(hostKind);
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const removeEntriesByScope = new Map<AgentScope, Set<string>>();
  let removedEntries = 0;
  for (const scope of agentState.scopes) {
    const names = Object.entries(scope.mcpServers)
      .filter(([name, entry]) => isRatelGatewayEntry(name, entry))
      .map(([name]) => name);
    if (names.length > 0) {
      removeEntriesByScope.set(scope.scope, new Set(names));
      removedEntries += names.length;
    }
  }
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const changes =
    removedEntries === 0
      ? []
      : (
          await agentHost.planChanges({
            state: agentState,
            bin: inputs.bin,
            ratelConfigPaths: {
              user: inputs.ratelUserPath,
              ...(inputs.ratelProjectPath ? { project: inputs.ratelProjectPath } : {}),
              ...(inputs.ratelLocalPath ? { local: inputs.ratelLocalPath } : {}),
            },
            removeEntriesByScope,
          })
        ).changes;
  return opts.preparedChanges.prepare({
    kind: "agent.fallback-cleanup",
    operations: changes.map((change) => ({
      kind: "replace-file" as const,
      path: change.path,
      contents: change.after,
    })),
    buildPreview: (mutation) => {
      assertAgentChangeSnapshots(changes, mutation);
      return { hostKind, removedEntries, files: changes.map(toAgentFileDiff) };
    },
    captureBackup:
      changes.length === 0
        ? undefined
        : async () => {
            const session = startBackup(ctx.env, ctx.fs);
            for (const change of changes) await session.capture(change.path);
            return session.finalize("link");
          },
    affectedContexts: affectedContextsForAgentChange(ctx),
    result: { hostKind, removedEntries },
  });
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
  plan: AgentImportDraft,
  opts: AgentInteropOptions,
): Promise<AgentImportDraft> {
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

function emptyAgentPlan(conflictStrategy: ImportConflictStrategy): AgentImportDraft {
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
  plan: AgentImportDraft,
  opts: { emptyReason?: string | null } = {},
): PlannedAgentChange {
  return {
    flow,
    host,
    candidates,
    selected,
    plan,
    emptyReason:
      opts.emptyReason ?? emptyReasonForPreview(flow, host.displayName, candidates, selected, plan),
  };
}

function emptyReasonForPreview(
  flow: "import" | "link",
  hostName: string,
  candidates: readonly AgentCandidate[],
  selected: readonly string[],
  plan: AgentImportDraft,
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
  const ratelUserText = await ctx.fs.read(ratelUserPath);
  const ratelProjectText = ratelProjectPath
    ? await readSafeProjectConfigText(ctx, ratelProjectPath)
    : null;
  const ratelLocalText = ratelLocalPath
    ? await readSafeProjectConfigText(ctx, ratelLocalPath)
    : null;
  const ratelUser = await withImplicitUserSkillDirectory(ctx, parseRatelConfigText(ratelUserText));

  return {
    agentHost,
    agentState,
    ratelUser,
    ratelProject: parseRatelConfigText(ratelProjectText),
    ratelLocal: parseRatelConfigText(ratelLocalText),
    ratelUserText,
    ratelProjectText,
    ratelLocalText,
    bin,
    ratelUserPath,
    ratelProjectPath,
    ratelLocalPath,
    projectRoot: ctx.env.projectRoot,
  };
}

async function readSafeProjectConfigText(ctx: CoreContext, path: string): Promise<string | null> {
  if (ctx.env.projectRoot && ctx.fs === nodeFs) {
    await assertSafeProjectControlPath(ctx.env.projectRoot, path);
  }
  return ctx.fs.read(path);
}

function parseRatelConfigText(text: string | null): RatelConfig | null {
  if (text === null) return null;
  const document = JSON.parse(text) as RatelConfigDocument;
  const normalized = parseConfig(document);
  return {
    ...document,
    mcpServers: normalized.mcpServers,
    ...(document.skills !== undefined ? { skills: document.skills } : {}),
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
