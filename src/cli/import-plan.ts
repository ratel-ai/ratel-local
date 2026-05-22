import { resolve } from "node:path";
import type { RatelConfig, ServerEntry } from "../lib/index.js";
import type { ClaudeConfigDoc, ClaudeScope } from "./claude.js";
import type { ResolvedBin } from "./locate-bin.js";

export interface ImportInputs {
  claudeUser: ClaudeConfigDoc | null;
  claudeProject: ClaudeConfigDoc | null;
  claudeLocal: ClaudeConfigDoc | null;
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
  scope: ClaudeScope;
  reason: string;
}

export interface ImportConflict {
  name: string;
  scope: ClaudeScope;
  incoming: ServerEntry;
  existing: ServerEntry;
}

export type ImportConflictStrategy = "add-missing-only" | "replace-from-agent" | "replace-selected";

export interface ImportPlan {
  ratelChanges: FileChange[];
  claudeChanges: FileChange[];
  summary: {
    movedFromUser: string[];
    movedFromProject: string[];
    movedFromLocal: string[];
    skipped: SkippedEntry[];
    conflicts: ImportConflict[];
    conflictStrategy: ImportConflictStrategy;
    ratelEntryArgsByScope: Partial<Record<ClaudeScope, string[]>>;
    overwrittenRatelEntries: ClaudeScope[];
  };
}

export interface BuildImportPlanOptions {
  selection?: ReadonlySet<string> | readonly string[];
  conflictStrategy?: ImportConflictStrategy;
  replaceConflicts?: ReadonlySet<string> | readonly string[];
}

const RATEL_NAME = "ratel-mcp";

interface ScopeBundle {
  movableNames: string[];
  movableEntries: Record<string, ServerEntry>;
  hadRatelEntry: boolean;
}

function bundleClaudeScope(doc: ClaudeConfigDoc | null): ScopeBundle {
  if (!doc) return { movableNames: [], movableEntries: {}, hadRatelEntry: false };
  const movableEntries: Record<string, ServerEntry> = {};
  const movableNames: string[] = [];
  let hadRatelEntry = false;
  for (const [name, entry] of Object.entries(doc.mcpServers)) {
    if (name === RATEL_NAME) {
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

  const g = bundleClaudeScope(inputs.claudeUser);
  const p = bundleClaudeScope(inputs.claudeProject);
  const l = bundleClaudeScope(inputs.claudeLocal);

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

  // Snapshot the names that will drive Claude rewrites BEFORE applyRatelWins
  // strips already-in-Ratel entries. A Claude rewrite is justified whenever
  // Ratel covers a Claude entry — whether it was just moved or was already
  // there from a prior import.
  const claudeRewriteG = g.movableNames.slice();
  const claudeRewriteP = p.movableNames.slice();
  const claudeRewriteL = l.movableNames.slice();

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

  // Compute ratel-mcp entry per scope: gated on the Claude-rewrite snapshot.
  const ratelEntryArgsByScope: Partial<Record<ClaudeScope, string[]>> = {};
  let userRatelEntry: ServerEntry | undefined;
  let projectRatelEntry: ServerEntry | undefined;
  let localRatelEntry: ServerEntry | undefined;

  if (claudeRewriteG.length > 0) {
    const args = ["--config", inputs.ratelUserPath];
    ratelEntryArgsByScope.user = args;
    userRatelEntry = makeRatelEntry(inputs.bin, args);
  }
  if (claudeRewriteP.length > 0 && inputs.ratelProjectPath) {
    const args = ["--config", inputs.ratelUserPath, "--config", inputs.ratelProjectPath];
    ratelEntryArgsByScope.project = args;
    projectRatelEntry = makeRatelEntry(inputs.bin, args);
  }
  if (claudeRewriteL.length > 0 && inputs.ratelLocalPath && inputs.ratelProjectPath) {
    const args = [
      "--config",
      inputs.ratelUserPath,
      "--config",
      inputs.ratelProjectPath,
      "--config",
      inputs.ratelLocalPath,
    ];
    ratelEntryArgsByScope.local = args;
    localRatelEntry = makeRatelEntry(inputs.bin, args);
  }

  const overwrittenRatelEntries: ClaudeScope[] = [];
  if (claudeRewriteG.length > 0 && g.hadRatelEntry) overwrittenRatelEntries.push("user");
  if (claudeRewriteP.length > 0 && p.hadRatelEntry) overwrittenRatelEntries.push("project");
  if (claudeRewriteL.length > 0 && l.hadRatelEntry) overwrittenRatelEntries.push("local");

  // Generate FileChanges, partitioned by audience.
  const ratelChanges: FileChange[] = [];
  const claudeChanges: FileChange[] = [];

  pushRatelWrite(ratelChanges, inputs.ratelUserPath, inputs.ratelUser, ratelUserNew);
  if (inputs.ratelProjectPath) {
    pushRatelWrite(ratelChanges, inputs.ratelProjectPath, inputs.ratelProject, ratelProjectNew);
  }
  if (inputs.ratelLocalPath) {
    pushRatelWrite(ratelChanges, inputs.ratelLocalPath, inputs.ratelLocal, ratelLocalNew);
  }

  // ~/.claude.json (global + local rewrites coalesced)
  const homeDoc = inputs.claudeUser ?? inputs.claudeLocal;
  if (homeDoc && (claudeRewriteG.length > 0 || claudeRewriteL.length > 0)) {
    const newRaw = rewriteHomeClaude(
      homeDoc.raw,
      userRatelEntry,
      localRatelEntry,
      claudeRewriteG.length > 0 ? new Set(claudeRewriteG) : null,
      claudeRewriteL.length > 0 ? new Set(claudeRewriteL) : null,
      inputs.projectRoot ?? deriveProjectRoot(inputs),
    );
    pushClaudeWrite(claudeChanges, homeDoc.path, homeDoc.raw, newRaw);
  }

  // <root>/.mcp.json
  if (inputs.claudeProject && claudeRewriteP.length > 0 && inputs.ratelProjectPath) {
    const newRaw = rewriteProjectClaude(
      inputs.claudeProject.raw,
      projectRatelEntry,
      new Set(claudeRewriteP),
    );
    pushClaudeWrite(claudeChanges, inputs.claudeProject.path, inputs.claudeProject.raw, newRaw);
  }

  return {
    ratelChanges,
    claudeChanges,
    summary: {
      movedFromUser: g.movableNames.slice(),
      movedFromProject: p.movableNames.slice(),
      movedFromLocal: l.movableNames.slice(),
      skipped,
      conflicts,
      conflictStrategy,
      ratelEntryArgsByScope,
      overwrittenRatelEntries,
    },
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
  scope: ClaudeScope,
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

export function conflictKey(scope: ClaudeScope, name: string): string {
  return `${scope}:${name}`;
}

function entriesEquivalent(a: ServerEntry, b: ServerEntry): boolean {
  return canonicalJson(normalizeEntry(a)) === canonicalJson(normalizeEntry(b));
}

function normalizeEntry(entry: ServerEntry): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if (out.type === undefined) out.type = "stdio";
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

function makeRatelEntry(bin: ResolvedBin, configArgs: string[]): ServerEntry {
  return {
    type: "stdio",
    command: bin.command,
    args: [...bin.args, "serve", ...configArgs],
  };
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

function pushClaudeWrite(
  changes: FileChange[],
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const beforeText = serialize(before);
  const afterText = serialize(after);
  if (beforeText !== afterText) {
    changes.push({ kind: "write", path, before: beforeText, after: afterText });
  }
}

function rewriteHomeClaude(
  raw: Record<string, unknown>,
  userRatelEntry: ServerEntry | undefined,
  localRatelEntry: ServerEntry | undefined,
  removeUser: ReadonlySet<string> | null,
  removeLocal: ReadonlySet<string> | null,
  projectRoot: string | undefined,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  if (removeUser && userRatelEntry) {
    const before = isPlainObject(out.mcpServers) ? (out.mcpServers as Record<string, unknown>) : {};
    out.mcpServers = mergeWithRatel(before, removeUser, userRatelEntry);
  }
  if (removeLocal && localRatelEntry && projectRoot) {
    const absRoot = resolve(projectRoot);
    const projects = isPlainObject(out.projects) ? (out.projects as Record<string, unknown>) : {};
    const entry = isPlainObject(projects[absRoot])
      ? { ...(projects[absRoot] as Record<string, unknown>) }
      : {};
    const before = isPlainObject(entry.mcpServers)
      ? (entry.mcpServers as Record<string, unknown>)
      : {};
    entry.mcpServers = mergeWithRatel(before, removeLocal, localRatelEntry);
    projects[absRoot] = entry;
    out.projects = projects;
  }
  return out;
}

function rewriteProjectClaude(
  raw: Record<string, unknown>,
  ratelEntry: ServerEntry | undefined,
  remove: ReadonlySet<string>,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  if (ratelEntry) {
    const before = isPlainObject(out.mcpServers) ? (out.mcpServers as Record<string, unknown>) : {};
    out.mcpServers = mergeWithRatel(before, remove, ratelEntry);
  }
  return out;
}

function mergeWithRatel(
  before: Record<string, unknown>,
  remove: ReadonlySet<string>,
  ratelEntry: ServerEntry,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(before)) {
    if (name === RATEL_NAME) continue;
    if (remove.has(name)) continue;
    next[name] = entry;
  }
  next[RATEL_NAME] = ratelEntry;
  return next;
}

function deriveProjectRoot(inputs: ImportInputs): string | undefined {
  if (inputs.ratelProjectPath) {
    return inputs.ratelProjectPath.replace(/\/\.ratel\/config\.json$/, "");
  }
  if (inputs.ratelLocalPath) {
    return inputs.ratelLocalPath.replace(/\/\.ratel\/config\.local\.json$/, "");
  }
  return undefined;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
