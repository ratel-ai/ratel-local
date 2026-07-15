import type {
  AgentHostAdapter,
  AgentHostChangeSet,
  AgentHostState,
  AgentScope,
} from "./agent-host/index.js";
import { isRatelGatewayEntry } from "./gateway-entry.js";
import { stableJsonStringify } from "./json.js";
import type { RatelConfig, ServerEntry } from "./lib/index.js";
import type { ResolvedBin } from "./locate-bin.js";

export interface ImportInputs {
  agentState: AgentHostState;
  ratelUser: RatelConfig | null;
  ratelProject: RatelConfig | null;
  ratelLocal: RatelConfig | null;
  bin: ResolvedBin;
  ratelUserPath: string;
  ratelProjectPath?: string;
  ratelLocalPath?: string;
  projectRoot?: string;
}

export type FileChange = {
  kind: "write";
  path: string;
  before: string | null;
  after: string;
};

export interface SkippedEntry {
  name: string;
  scope: AgentScope;
  reason: string;
}

export interface ImportConflict {
  name: string;
  scope: AgentScope;
  incoming: ServerEntry;
  existing: ServerEntry;
}

export type ImportConflictStrategy = "add-missing-only" | "replace-from-agent" | "replace-selected";

export interface ImportPlan {
  ratelChanges: FileChange[];
  agentChanges: FileChange[];
  agentHostChanges?: AgentHostChangeSet;
  summary: {
    movedFromUser: string[];
    movedFromProject: string[];
    movedFromLocal: string[];
    replacedFromUser: string[];
    replacedFromProject: string[];
    replacedFromLocal: string[];
    skipped: SkippedEntry[];
    conflicts: ImportConflict[];
    conflictStrategy: ImportConflictStrategy;
    ratelEntryArgsByScope: Partial<Record<AgentScope, string[]>>;
    overwrittenRatelEntries: AgentScope[];
  };
}

export interface BuildImportPlanOptions {
  selection?: ReadonlySet<string> | readonly string[];
  conflictStrategy?: ImportConflictStrategy;
  replaceConflicts?: ReadonlySet<string> | readonly string[];
}

interface ScopeBundle {
  movableNames: string[];
  movableEntries: Record<string, ServerEntry>;
  hadRatelEntry: boolean;
}

function bundleAgentScope(state: AgentHostState, scope: AgentScope): ScopeBundle {
  const scopeState = state.scopes.find((s) => s.scope === scope);
  if (!scopeState) return { movableNames: [], movableEntries: {}, hadRatelEntry: false };
  const movableEntries: Record<string, ServerEntry> = {};
  const movableNames: string[] = [];
  let hadRatelEntry = false;
  for (const [name, entry] of Object.entries(scopeState.mcpServers)) {
    if (isRatelGatewayEntry(name, entry)) {
      hadRatelEntry = true;
      continue;
    }
    movableEntries[name] = entry;
    movableNames.push(name);
  }
  return { movableNames, movableEntries, hadRatelEntry };
}

export function buildImportPlan(
  inputs: ImportInputs,
  options: BuildImportPlanOptions = {},
): ImportPlan {
  const skipped: SkippedEntry[] = [];
  const conflicts: ImportConflict[] = [];
  const selection = normalizeSelection(options.selection);
  const conflictStrategy = options.conflictStrategy ?? "add-missing-only";
  const replaceConflicts = normalizeSelection(options.replaceConflicts);

  const g = bundleAgentScope(inputs.agentState, "user");
  const p = bundleAgentScope(inputs.agentState, "project");
  const l = bundleAgentScope(inputs.agentState, "local");

  if (selection) {
    filterBundle(g, selection);
    filterBundle(p, selection);
    filterBundle(l, selection);
  }

  // Cross-scope dedup: most specific wins.
  for (const name of g.movableNames.slice()) {
    if (l.movableEntries[name]) {
      removeFromBundle(g, name);
      skipped.push({ name, scope: "user", reason: "shadowed by local scope" });
    } else if (p.movableEntries[name]) {
      removeFromBundle(g, name);
      skipped.push({ name, scope: "user", reason: "shadowed by project scope" });
    }
  }
  for (const name of p.movableNames.slice()) {
    if (l.movableEntries[name]) {
      removeFromBundle(p, name);
      skipped.push({ name, scope: "project", reason: "shadowed by local scope" });
    }
  }

  // Drop project/local scopes entirely if their paths are not configured.
  if (!inputs.ratelProjectPath) {
    for (const name of p.movableNames) {
      skipped.push({ name, scope: "project", reason: "no project root configured" });
    }
    p.movableNames = [];
    p.movableEntries = {};
  }
  if (!inputs.ratelLocalPath) {
    for (const name of l.movableNames) {
      skipped.push({ name, scope: "local", reason: "no project root configured" });
    }
    l.movableNames = [];
    l.movableEntries = {};
  }

  // Snapshot the names that will drive native host rewrites BEFORE conflict
  // handling strips already-in-Ratel entries.
  const agentRewriteG = g.movableNames.slice();
  const agentRewriteP = p.movableNames.slice();
  const agentRewriteL = l.movableNames.slice();

  // Apply conflict policy on collisions.
  const ratelUserNew = applyConflictStrategy(
    inputs.ratelUser,
    g,
    "user",
    skipped,
    conflicts,
    conflictStrategy,
    replaceConflicts,
  );
  const ratelProjectNew = inputs.ratelProjectPath
    ? applyConflictStrategy(
        inputs.ratelProject,
        p,
        "project",
        skipped,
        conflicts,
        conflictStrategy,
        replaceConflicts,
      )
    : null;
  const ratelLocalNew = inputs.ratelLocalPath
    ? applyConflictStrategy(
        inputs.ratelLocal,
        l,
        "local",
        skipped,
        conflicts,
        conflictStrategy,
        replaceConflicts,
      )
    : null;

  // Compute ratel-local entry per scope: gated on the Claude-rewrite snapshot.
  const ratelEntryArgsByScope: Partial<Record<AgentScope, string[]>> = {};

  if (agentRewriteG.length > 0) {
    const args = ["--config", inputs.ratelUserPath];
    ratelEntryArgsByScope.user = args;
  }
  if (agentRewriteP.length > 0 && inputs.ratelProjectPath) {
    const args = ["--config", inputs.ratelUserPath, "--config", inputs.ratelProjectPath];
    ratelEntryArgsByScope.project = args;
  }
  if (agentRewriteL.length > 0 && inputs.ratelLocalPath && inputs.ratelProjectPath) {
    const args = [
      "--config",
      inputs.ratelUserPath,
      "--config",
      inputs.ratelProjectPath,
      "--config",
      inputs.ratelLocalPath,
    ];
    ratelEntryArgsByScope.local = args;
  }

  const overwrittenRatelEntries: AgentScope[] = [];
  if (agentRewriteG.length > 0 && g.hadRatelEntry) overwrittenRatelEntries.push("user");
  if (agentRewriteP.length > 0 && p.hadRatelEntry) overwrittenRatelEntries.push("project");
  if (agentRewriteL.length > 0 && l.hadRatelEntry) overwrittenRatelEntries.push("local");

  // Generate FileChanges, partitioned by audience.
  const ratelChanges: FileChange[] = [];

  pushRatelWrite(ratelChanges, inputs.ratelUserPath, inputs.ratelUser, ratelUserNew);
  if (inputs.ratelProjectPath) {
    pushRatelWrite(ratelChanges, inputs.ratelProjectPath, inputs.ratelProject, ratelProjectNew);
  }
  if (inputs.ratelLocalPath) {
    pushRatelWrite(ratelChanges, inputs.ratelLocalPath, inputs.ratelLocal, ratelLocalNew);
  }

  return {
    ratelChanges,
    agentChanges: [],
    summary: {
      movedFromUser: g.movableNames.slice(),
      movedFromProject: p.movableNames.slice(),
      movedFromLocal: l.movableNames.slice(),
      replacedFromUser: agentRewriteG,
      replacedFromProject: agentRewriteP,
      replacedFromLocal: agentRewriteL,
      skipped,
      conflicts,
      conflictStrategy,
      ratelEntryArgsByScope,
      overwrittenRatelEntries,
    },
  };
}

export async function buildAgentImportPlan(
  inputs: ImportInputs & { agentHost: AgentHostAdapter; agentState: AgentHostState },
  options: BuildImportPlanOptions = {},
): Promise<ImportPlan> {
  const base = buildImportPlan(inputs, options);
  const removeEntriesByScope = new Map<AgentScope, Set<string>>();
  for (const scope of ["user", "project", "local"] as const) {
    const moved =
      scope === "user"
        ? base.summary.replacedFromUser
        : scope === "project"
          ? base.summary.replacedFromProject
          : base.summary.replacedFromLocal;
    if (moved.length > 0) removeEntriesByScope.set(scope, new Set(moved));
  }
  const installGatewayScopes = new Set<AgentScope>();
  for (const scopeState of inputs.agentState.scopes) {
    if (!removeEntriesByScope.has(scopeState.scope)) continue;
    const hasLegacyGateway = Object.entries(scopeState.mcpServers).some(
      ([name, entry]) => name !== "ratel-local" && isRatelGatewayEntry(name, entry),
    );
    if (hasLegacyGateway) installGatewayScopes.add(scopeState.scope);
  }
  const agentHostChanges = await inputs.agentHost.planChanges({
    state: inputs.agentState,
    bin: inputs.bin,
    ratelConfigPaths: {
      user: inputs.ratelUserPath,
      project: inputs.ratelProjectPath,
      local: inputs.ratelLocalPath,
    },
    installGatewayScopes,
    removeEntriesByScope,
  });
  return {
    ...base,
    agentChanges: agentHostChanges.changes,
    agentHostChanges,
  };
}

export async function buildAgentLinkPlan(
  inputs: ImportInputs & { agentHost: AgentHostAdapter; agentState: AgentHostState },
): Promise<ImportPlan> {
  const installGatewayScopes = collectLinkableAgentScopes(inputs.agentState);
  const agentHostChanges = await inputs.agentHost.planChanges({
    state: inputs.agentState,
    bin: inputs.bin,
    ratelConfigPaths: {
      user: inputs.ratelUserPath,
      project: inputs.ratelProjectPath,
      local: inputs.ratelLocalPath,
    },
    installGatewayScopes,
    removeEntriesByScope: new Map(),
  });
  return {
    ratelChanges: [],
    agentChanges: agentHostChanges.changes,
    agentHostChanges,
    summary: emptyImportSummary("add-missing-only"),
  };
}

function collectLinkableAgentScopes(state: AgentHostState): Set<AgentScope> {
  const out = new Set<AgentScope>();
  for (const scope of state.scopes) if (scope.available) out.add(scope.scope);
  return out;
}

function emptyImportSummary(conflictStrategy: ImportConflictStrategy): ImportPlan["summary"] {
  return {
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
  };
}

function removeFromBundle(bundle: ScopeBundle, name: string): void {
  delete bundle.movableEntries[name];
  const idx = bundle.movableNames.indexOf(name);
  if (idx >= 0) bundle.movableNames.splice(idx, 1);
}

function normalizeSelection(
  sel: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (sel === undefined) return null;
  return sel instanceof Set ? sel : new Set(sel);
}

function filterBundle(bundle: ScopeBundle, selection: ReadonlySet<string>): void {
  for (const name of bundle.movableNames.slice()) {
    if (!selection.has(name)) removeFromBundle(bundle, name);
  }
}

function applyConflictStrategy(
  ratel: RatelConfig | null,
  bundle: ScopeBundle,
  scope: AgentScope,
  skipped: SkippedEntry[],
  conflicts: ImportConflict[],
  strategy: ImportConflictStrategy,
  replaceConflicts: ReadonlySet<string> | null,
): RatelConfig | null {
  const out: Record<string, ServerEntry> = ratel ? { ...ratel.mcpServers } : {};
  for (const name of bundle.movableNames.slice()) {
    if (out[name]) {
      if (entriesEquivalent(out[name], bundle.movableEntries[name])) {
        bundle.movableEntries[name] = out[name];
        continue;
      }
      conflicts.push({ name, scope, incoming: bundle.movableEntries[name], existing: out[name] });
      const shouldReplace =
        strategy === "replace-from-agent" ||
        (strategy === "replace-selected" && replaceConflicts?.has(conflictKey(scope, name)));
      if (!shouldReplace) {
        skipped.push({
          name,
          scope,
          reason: `conflicts with existing Ratel ${scope} config`,
        });
        removeFromBundle(bundle, name);
        continue;
      }
    }
    out[name] = bundle.movableEntries[name];
  }
  if (!ratel && Object.keys(out).length === 0) return null;
  return { mcpServers: out };
}

export function conflictKey(scope: AgentScope, name: string): string {
  return `${scope}:${name}`;
}

function entriesEquivalent(a: ServerEntry, b: ServerEntry): boolean {
  return stableJsonStringify(normalizeEntry(a)) === stableJsonStringify(normalizeEntry(b));
}

function normalizeEntry(entry: ServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (out.type === undefined) out.type = "stdio";
  return out;
}

function pushRatelWrite(
  changes: FileChange[],
  path: string,
  before: RatelConfig | null,
  after: RatelConfig | null,
) {
  if (!after) return;
  const beforeText = before ? serialize(before) : null;
  const afterText = serialize(after);
  if (beforeText !== afterText) {
    changes.push({ kind: "write", path, before: beforeText, after: afterText });
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
