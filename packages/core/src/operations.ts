import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  AgentHostAdapter,
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
  type BackupFs,
  type BackupManifest,
  listBackups,
  startBackup,
} from "./backup.js";
import { isRatelGatewayEntry } from "./gateway-entry.js";
import { ProjectRootNotFoundError, type RatelScope, ratelConfigPath } from "./hierarchy.js";
import {
  buildAgentImportPlan,
  buildAgentLinkPlan,
  type FileChange,
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
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames: string[];
  ratelEntryNames: string[];
  missingRatelEntryNames: string[];
  scopes: AgentScopePosture[];
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

export interface ApplyAgentLinkInput extends PreviewAgentLinkInput {
  planHash: string;
}

export async function getAgentHostsState(ctx: CoreContext): Promise<AgentHostsState> {
  const hosts: DetectedAgentHostSummary[] = [];
  const ratelKnownNames = collectRatelKnownNames(await readAllRatelConfigs(ctx));
  for (const host of SUPPORTED_AGENT_HOSTS) {
    const adapter = new NamedAgentHostAdapter(host.kind);
    const detection = await adapter.detect({ env: ctx.env, fs: ctx.fs });
    let state: AgentHostState | null = null;
    try {
      state = await adapter.read({ env: ctx.env, fs: ctx.fs });
    } catch (err) {
      detection.warnings.push(`Failed to read ${host.displayName}: ${(err as Error).message}`);
    }
    hosts.push(
      summarizeDetectedAgentHost(host.kind, host.displayName, detection, state, ratelKnownNames),
    );
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
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const host = summarizeDetectedAgentHost(
    hostKind,
    agentState.host.displayName,
    detection,
    agentState,
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
  const plan = await buildAgentImportPlan(inputs, {
    selection: new Set(selected),
    conflictStrategy: input.conflictStrategy ?? "add-missing-only",
    replaceConflicts: input.replaceConflicts ?? [],
  });
  return toAgentPlanPreview("import", host, candidates, selected, plan, input);
}

export async function previewAgentLink(
  ctx: CoreContext,
  input: PreviewAgentLinkInput,
  opts: AgentInteropOptions = {},
): Promise<AgentPlanPreview> {
  const hostKind = assertSupportedAgentHostKind(input.hostKind);
  const agentHost = new NamedAgentHostAdapter(hostKind);
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const host = summarizeDetectedAgentHost(
    hostKind,
    agentState.host.displayName,
    detection,
    agentState,
    collectRatelKnownNames(await readAllRatelConfigs(ctx)),
  );
  const inputs = await buildAgentPlanInputs(ctx, agentHost, agentState, opts);
  const ratelKnown = collectRatelKnownNames([
    inputs.ratelUser,
    inputs.ratelProject,
    inputs.ratelLocal,
  ]);

  if (ratelKnown.size === 0) {
    const plan = emptyAgentPlan("add-missing-only");
    return toAgentPlanPreview("link", host, [], [], plan, input, {
      emptyReason:
        "No Ratel entries found at any scope. Import entries first, then link the agent.",
    });
  }

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
  return executePlan(preview.plan.ratelChanges, { fs: ctx.fs, env: ctx.env, action: "import" });
}

export async function applyAgentImportAgent(
  ctx: CoreContext,
  input: ApplyAgentImportInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentImport(ctx, input, opts);
  assertPlanHash(input.planHash, preview.stageHashes.agent);
  if (preview.plan.agentChanges.length === 0) return null;
  return executePlan(preview.plan.agentChanges, { fs: ctx.fs, env: ctx.env, action: "import" });
}

export async function applyAgentLink(
  ctx: CoreContext,
  input: ApplyAgentLinkInput,
  opts: AgentInteropOptions = {},
): Promise<BackupManifest | null> {
  const preview = await previewAgentLink(ctx, input, opts);
  assertPlanHash(input.planHash, preview.stageHashes.agent);
  if (preview.plan.agentChanges.length === 0) return null;
  return executePlan(preview.plan.agentChanges, { fs: ctx.fs, env: ctx.env, action: "link" });
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

  const plan = await buildAgentLinkPlan(inputs);
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

function assertSupportedAgentHostKind(value: unknown): SupportedAgentHostKind {
  if (isSupportedAgentHostKind(value)) return value;
  throw new Error(`agent host must be one of claude-code|codex, got ${JSON.stringify(value)}`);
}

function summarizeDetectedAgentHost(
  kind: SupportedAgentHostKind,
  displayName: string,
  detection: AgentHostDetection,
  state: AgentHostState | null,
  ratelKnownNames: ReadonlySet<string> = new Set(),
): DetectedAgentHostSummary {
  const scopes = state?.scopes.map(summarizeAgentScope) ?? [];
  const nativeEntryCount = scopes.reduce((sum, scope) => sum + scope.nativeEntryCount, 0);
  const ratelEntryCount = scopes.reduce((sum, scope) => sum + scope.ratelEntryCount, 0);
  const entryCount = nativeEntryCount + ratelEntryCount;
  const nativeEntryNames = [...new Set(scopes.flatMap((scope) => scope.nativeEntryNames))].sort();
  const ratelEntryNames = [...new Set(scopes.flatMap((scope) => scope.ratelEntryNames))].sort();
  return {
    kind,
    displayName,
    detection,
    posture: detection.present
      ? classifyPosture({ available: true, nativeEntryCount, ratelEntryCount })
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
    posture: classifyPosture({ available: scope.available, nativeEntryCount, ratelEntryCount }),
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
  ratelEntryCount: number;
}): AgentPosture {
  if (!input.available) return "unavailable";
  if (input.nativeEntryCount === 0 && input.ratelEntryCount === 0) return "empty";
  if (input.nativeEntryCount === 0) return "ratel-only";
  if (input.ratelEntryCount === 0) return "not-linked";
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

async function readAllRatelConfigs(ctx: CoreContext): Promise<(RatelConfig | null)[]> {
  const configs: (RatelConfig | null)[] = [];
  for (const scope of SCOPES) {
    try {
      configs.push(await readJson<RatelConfig>(ctx.fs, ratelConfigPath(scope, ctx.env)));
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
    throw new Error("preview is stale; scan again and review the latest changes before applying");
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
