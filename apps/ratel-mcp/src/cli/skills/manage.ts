import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The agent whose native skill folder Ratel manages. */
export type SkillSource = "claude" | "codex";

/**
 * Locations the skill manager links and patches. `nativeDir` (Claude Code) and
 * `codexDir` (Codex) are where each agent auto-loads skills (always-on
 * metadata); `managedDir` is the Ratel-managed folder the gateway scans (loaded
 * on demand). The manifest records exactly which skills Ratel linked, where
 * their native metadata lives, and the Ratel-owned metadata edits to revert on
 * `deactivate`.
 */
export interface SkillManagePaths {
  nativeDir: string;
  codexDir: string;
  managedDir: string;
  manifestPath: string;
}

export function defaultSkillManagePaths(home: string = homedir()): SkillManagePaths {
  return {
    nativeDir: join(home, ".claude", "skills"),
    codexDir: join(home, ".codex", "skills"),
    managedDir: join(home, ".ratel", "skills"),
    manifestPath: join(home, ".ratel", "skill-manifest.json"),
  };
}

export interface ManagedEntry {
  id: string;
  /** New entries are linked in place; missing mode means a legacy moved entry. */
  mode?: "linked";
  /** Absolute path to the native skill directory. Legacy entries were originally moved from here. */
  originalPath: string;
  /** Absolute path of the Ratel-managed symlink for linked entries. */
  linkPath?: string;
  /** Which agent's folder owns the native skill.
   *  Optional for manifests written before multi-source support (treated as
   *  "claude", the only source that existed then). */
  source?: SkillSource;
  movedAt: string;
  /** Metadata edits Ratel made to keep the native host manual-only. */
  metadataPatch?: MetadataPatch[];
}

export interface MetadataPatch {
  path: string;
  before?: string;
  after: string;
  created?: boolean;
}

interface SkillManifest {
  version: 1;
  managed: ManagedEntry[];
}

export interface ManageOptions {
  logger?: (message: string) => void;
  /** When true, report what would be managed without touching the filesystem. */
  dryRun?: boolean;
  /** Restrict the operation to these skill ids. Omit to operate on all. */
  ids?: string[];
  /** Activate only from this agent's folder — disambiguates a name that exists
   *  in both Claude and Codex. Omit to scan both (Claude first). */
  source?: SkillSource;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface ActivateResult {
  /** Compatibility field name: entries newly managed through Ratel. */
  moved: ManagedEntry[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface DeactivateResult {
  /** Compatibility field name: entries Ratel stopped managing. */
  restored: ManagedEntry[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Link every native skill (a `<name>/SKILL.md` under the host skill dir) into
 * the Ratel-managed folder, recording each in the manifest. The native folder
 * stays in place but is patched manual-only so the host won't auto-load it.
 * Idempotent and non-destructive: a name already present in `managedDir` is
 * skipped, never overwritten.
 */
export async function activateSkills(
  paths: SkillManagePaths,
  options: ManageOptions = {},
): Promise<ActivateResult> {
  const log = options.logger ?? (() => {});
  const now = options.now ?? (() => new Date());
  const manifest = await readManifest(paths.manifestPath);
  const already = new Set(manifest.managed.filter(isValidEntry).map((m) => m.id));

  const moved: ManagedEntry[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  // Claude first, then Codex: a skill id present in both is taken from Claude and
  // skipped for Codex (one id can only occupy one managed folder slot).
  const sources: Array<{ dir: string; source: SkillSource }> = [
    { dir: paths.nativeDir, source: "claude" },
    { dir: paths.codexDir, source: "codex" },
  ];

  // Persist the manifest after each successful management change (atomically),
  // so a crash mid-loop leaves a manifest that reflects what Ratel owns. The
  // finally is a backstop in case the throw was the manifest write itself.
  try {
    for (const { dir, source } of sources) {
      if (options.source && options.source !== source) continue;
      for (const id of await skillDirNames(dir)) {
        if (options.ids && !options.ids.includes(id)) continue;
        const from = join(dir, id);
        const to = join(paths.managedDir, id);
        if (already.has(id) || (await pathExists(to))) {
          skipped.push({ id, reason: "already present in managed folder" });
          log(`[ratel] skill ${id}: already managed — skipping`);
          continue;
        }
        if (options.dryRun) {
          log(`[ratel] would manage skill ${id} (${source}) as invoke-only`);
          moved.push({
            id,
            mode: "linked",
            originalPath: from,
            linkPath: to,
            source,
            movedAt: now().toISOString(),
          });
          already.add(id);
          continue;
        }
        await mkdir(paths.managedDir, { recursive: true });
        try {
          await symlink(from, to, process.platform === "win32" ? "junction" : "dir");
        } catch (err) {
          skipped.push({ id, reason: `could not create managed link: ${(err as Error).message}` });
          log(`[ratel] skill ${id}: could not create managed link — skipping`);
          continue;
        }
        let metadataPatch: MetadataPatch[];
        try {
          metadataPatch = await prepareManualOnlyMetadata(from, source);
        } catch (err) {
          await rm(to, { recursive: true, force: true }).catch(() => {});
          skipped.push({
            id,
            reason: `could not apply manual-only metadata: ${(err as Error).message}`,
          });
          log(`[ratel] skill ${id}: could not apply manual-only metadata — skipping`);
          continue;
        }
        const entry: ManagedEntry = {
          id,
          mode: "linked",
          originalPath: from,
          linkPath: to,
          source,
          movedAt: now().toISOString(),
          metadataPatch,
        };
        manifest.managed.push(entry);
        try {
          await writeManifest(paths.manifestPath, manifest);
        } catch (err) {
          manifest.managed = manifest.managed.filter((managed) => managed !== entry);
          await rm(to, { recursive: true, force: true }).catch(() => {});
          skipped.push({
            id,
            reason: `could not record managed skill: ${(err as Error).message}`,
          });
          log(`[ratel] skill ${id}: could not record manifest entry — skipping`);
          continue;
        }
        try {
          await applyMetadataPatches(metadataPatch);
        } catch (err) {
          manifest.managed = manifest.managed.filter((managed) => managed !== entry);
          await rm(to, { recursive: true, force: true }).catch(() => {});
          await writeManifest(paths.manifestPath, manifest).catch(() => {});
          skipped.push({
            id,
            reason: `could not apply manual-only metadata: ${(err as Error).message}`,
          });
          log(`[ratel] skill ${id}: could not apply manual-only metadata — skipping`);
          continue;
        }
        moved.push(entry);
        already.add(id);
        log(`[ratel] managing skill ${id} (${source}) as invoke-only`);
      }
    }
  } finally {
    if (!options.dryRun && moved.length > 0) {
      await writeManifest(paths.manifestPath, manifest).catch(() => {});
    }
  }
  return { moved, skipped };
}

/**
 * Stop managing every skill the manifest recorded, then clear those entries.
 * Linked entries have their managed symlink removed and their native metadata
 * restored. Legacy moved entries are copied back to their canonical native
 * folder. Skills added directly to the managed folder (not in the manifest)
 * stay put. Idempotent: a missing skill or an occupied destination is skipped,
 * not clobbered.
 */
export async function deactivateSkills(
  paths: SkillManagePaths,
  options: ManageOptions = {},
): Promise<DeactivateResult> {
  const log = options.logger ?? (() => {});
  const manifest = await readManifest(paths.manifestPath);

  const restored: ManagedEntry[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const remaining: ManagedEntry[] = [];

  for (const entry of manifest.managed) {
    if (!isValidEntry(entry)) {
      // A malformed entry (hand-edited / partially-written manifest). Preserve it
      // untouched and move on, rather than crashing the whole restore batch.
      skipped.push({
        id: String((entry as { id?: unknown }).id),
        reason: "malformed manifest entry",
      });
      remaining.push(entry);
      log("[ratel] malformed manifest entry — leaving managed, skipping restore");
      continue;
    }
    if (options.ids && !options.ids.includes(entry.id)) {
      remaining.push(entry);
      continue;
    }
    if (!isSafeSkillId(entry.id)) {
      // The manifest is untrusted on read (stale cross-machine copy, corruption,
      // tampering). Never move based on an id that isn't a single safe segment.
      skipped.push({ id: String(entry.id), reason: "unsafe skill id in manifest" });
      remaining.push(entry);
      log(`[ratel] skill ${String(entry.id)}: unsafe id in manifest — leaving managed`);
      continue;
    }
    if (entry.mode === "linked") {
      const linkPath = entry.linkPath ?? join(paths.managedDir, entry.id);
      const linkExists = await pathExists(linkPath);
      if (options.dryRun) {
        log(`[ratel] would stop managing skill ${entry.id}`);
        restored.push(entry);
        remaining.push(entry);
        continue;
      }
      if (linkExists) {
        await rm(linkPath, { recursive: true, force: true });
      } else {
        log(`[ratel] skill ${entry.id}: managed link is gone — restoring metadata only`);
      }
      try {
        await restoreManualOnlyMetadata(entry, log);
      } catch (err) {
        skipped.push({
          id: entry.id,
          reason: `could not restore native metadata: ${(err as Error).message}`,
        });
        remaining.push(entry);
        log(`[ratel] skill ${entry.id}: could not restore native metadata — leaving managed`);
        continue;
      }
      restored.push(entry);
      log(`[ratel] stopped managing skill ${entry.id}`);
      continue;
    }

    const from = join(paths.managedDir, entry.id);
    // Restore to the canonical path derived from the id plus the recorded source
    // agent — do NOT trust the manifest's `originalPath`, which can be stale
    // (synced from another machine with a different $HOME) or crafted to escape
    // the skill dirs. `source` is a closed enum, so the destination dir is always
    // one of our own; an absent/unknown source falls back to Claude (the only
    // source that pre-dated multi-agent support).
    const sourceDir = entry.source === "codex" ? paths.codexDir : paths.nativeDir;
    const dest = join(sourceDir, entry.id);
    if (!(await exists(from))) {
      skipped.push({ id: entry.id, reason: "no longer in managed folder" });
      log(`[ratel] skill ${entry.id}: gone from managed folder — dropping from manifest`);
      continue;
    }
    if (await exists(dest)) {
      skipped.push({ id: entry.id, reason: "destination already occupied" });
      remaining.push(entry);
      log(`[ratel] skill ${entry.id}: ${dest} already exists — leaving managed`);
      continue;
    }
    if (options.dryRun) {
      log(`[ratel] would restore legacy skill ${entry.id} → ${dest}`);
      restored.push(entry);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await moveDir(from, dest);
    restored.push(entry);
    log(`[ratel] restored legacy skill ${entry.id} → ${dest}`);
  }

  // Only rewrite the manifest when it actually changed (an entry was restored or
  // dropped). Avoids touching disk — and failing on a missing/unwritable `.ratel`
  // dir — when there was nothing to deactivate.
  if (!options.dryRun && remaining.length !== manifest.managed.length) {
    await writeManifest(paths.manifestPath, { version: 1, managed: remaining });
  }
  return { restored, skipped };
}

/** Read the well-formed managed-skill entries (empty when none). */
export async function listManaged(paths: SkillManagePaths): Promise<ManagedEntry[]> {
  return (await readManifest(paths.manifestPath)).managed.filter(isValidEntry);
}

async function skillDirNames(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if ((await isDirectoryEntry(dir, entry)) && (await exists(join(dir, entry.name, "SKILL.md")))) {
      names.push(entry.name);
    }
  }
  return names;
}

async function isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/** Move a directory, falling back to a copy across filesystems (EXDEV). */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  // Cross-device (EXDEV): copy to a temp sibling, then atomically rename it into
  // place, then remove the source. A crash or partial copy never leaves a
  // half-written skill at `to` — the rename only ever exposes a fully-copied dir.
  const tmp = `${to}.ratel-tmp-${randomUUID()}`;
  try {
    await cp(from, tmp, { recursive: true });
    await rename(tmp, to);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  await rm(from, { recursive: true, force: true });
}

async function readManifest(path: string): Promise<SkillManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, managed: [] };
    throw err;
  }
  let parsed: Partial<SkillManifest>;
  try {
    parsed = JSON.parse(text) as Partial<SkillManifest>;
  } catch (err) {
    // A corrupt manifest (truncated/partial write, hand-edit). Refuse to proceed:
    // re-throwing the raw SyntaxError is opaque, and defaulting to an empty list
    // would silently abandon every managed skill. Surface a clear, actionable error.
    throw new SkillManifestError(
      `skill manifest at ${path} is not valid JSON (${(err as Error).message}). ` +
        "Fix or remove it before running skill commands — refusing to proceed so managed skills aren't lost.",
    );
  }
  if (!Array.isArray(parsed.managed)) {
    throw new SkillManifestError(
      `skill manifest at ${path} is missing its \`managed\` array. ` +
        "Fix or remove it before running skill commands — refusing to proceed so managed skills aren't lost.",
    );
  }
  return { version: 1, managed: parsed.managed };
}

/** Write the manifest atomically (temp file + rename) so a crash mid-write can't
 *  leave a truncated JSON file behind. */
async function writeManifest(path: string, manifest: SkillManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.ratel-tmp-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function writeTextFileAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.ratel-tmp-${randomUUID()}`;
  await writeFile(tmp, text, "utf8");
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Thrown when the on-disk manifest is corrupt; surfaced as a clean CLI error. */
export class SkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillManifestError";
  }
}

/** A well-formed manifest entry: `id`/`originalPath`/`movedAt` all present strings. */
function isValidEntry(entry: unknown): entry is ManagedEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === "string" && typeof e.originalPath === "string" && typeof e.movedAt === "string"
  );
}

/** A manifest skill id must be a single safe path segment (no separators, no `..`). */
function isSafeSkillId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    !id.includes("\\") &&
    id !== "." &&
    id !== ".."
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareManualOnlyMetadata(
  skillDir: string,
  source: SkillSource,
): Promise<MetadataPatch[]> {
  return source === "claude"
    ? [await prepareClaudeSkillPatch(skillDir)]
    : [await prepareCodexSkillPatch(skillDir)];
}

async function prepareClaudeSkillPatch(skillDir: string): Promise<MetadataPatch> {
  const path = join(skillDir, "SKILL.md");
  const before = await readFile(path, "utf8");
  const after = setYamlScalarInFrontmatter(before, "disable-model-invocation", "true");
  return { path, before, after };
}

async function prepareCodexSkillPatch(skillDir: string): Promise<MetadataPatch> {
  const path = join(skillDir, "agents", "openai.yaml");
  let before: string | undefined;
  try {
    before = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const after = setCodexManualOnly(before ?? "");
  return { path, before, after, created: before === undefined };
}

async function applyMetadataPatches(patches: MetadataPatch[]): Promise<void> {
  for (const patch of patches) {
    if (patch.after !== patch.before) await writeTextFileAtomic(patch.path, patch.after);
  }
}

async function restoreManualOnlyMetadata(
  entry: ManagedEntry,
  log: (message: string) => void,
): Promise<void> {
  for (const patch of entry.metadataPatch ?? []) {
    let current: string | undefined;
    try {
      current = await readFile(patch.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (current !== patch.after) {
      const restored = restoreClaudeManualOnlyMarker(current, patch);
      if (restored !== undefined && restored !== current) {
        await writeTextFileAtomic(patch.path, restored);
        continue;
      }
      log(`[ratel] skill ${entry.id}: metadata changed since activation — leaving ${patch.path}`);
      continue;
    }
    if (patch.created) {
      await rm(patch.path, { force: true });
    } else if (patch.before !== undefined) {
      await writeTextFileAtomic(patch.path, patch.before);
    }
  }
}

function restoreClaudeManualOnlyMarker(
  current: string | undefined,
  patch: MetadataPatch,
): string | undefined {
  if (current === undefined || patch.before === undefined || !patch.path.endsWith("SKILL.md")) {
    return current;
  }
  return restoreYamlScalarInFrontmatter(current, "disable-model-invocation", patch.before);
}

function setYamlScalarInFrontmatter(raw: string, key: string, value: string): string {
  const lines = raw.split(/\r?\n/);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (lines[first]?.trim() !== "---") throw new Error("SKILL.md is missing YAML frontmatter");
  let end = -1;
  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("SKILL.md frontmatter is not closed");
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);
  for (let i = first + 1; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${key}: ${value}`;
      return lines.join(newline);
    }
  }
  lines.splice(end, 0, `${key}: ${value}`);
  return lines.join(newline);
}

function restoreYamlScalarInFrontmatter(raw: string, key: string, before: string): string {
  const beforeLine = getYamlScalarLineFromFrontmatter(before, key);
  const lines = raw.split(/\r?\n/);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const range = yamlFrontmatterRange(lines);
  if (!range) return raw;

  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);
  const indexes: number[] = [];
  for (let i = range.start + 1; i < range.end; i++) {
    if (re.test(lines[i])) indexes.push(i);
  }
  if (indexes.length === 0) return raw;

  if (beforeLine === undefined) {
    for (const index of indexes.reverse()) lines.splice(index, 1);
  } else {
    lines[indexes[0]] = beforeLine;
    for (const index of indexes.slice(1).reverse()) lines.splice(index, 1);
  }
  return lines.join(newline);
}

function getYamlScalarLineFromFrontmatter(raw: string, key: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  const range = yamlFrontmatterRange(lines);
  if (!range) return undefined;

  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);
  for (let i = range.start + 1; i < range.end; i++) {
    if (re.test(lines[i])) return lines[i];
  }
  return undefined;
}

function yamlFrontmatterRange(lines: string[]): { start: number; end: number } | undefined {
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  if (lines[first]?.trim() !== "---") return undefined;

  for (let i = first + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") return { start: first, end: i };
  }
  return undefined;
}

function setCodexManualOnly(raw: string): string {
  if (!raw.trim()) return "policy:\n  allow_implicit_invocation: false\n";

  const lines = raw.replace(/\r\n/g, "\n").replace(/\n*$/, "").split("\n");
  const policyIndexes = lines
    .map((line, index) => (/^policy\s*:/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (policyIndexes.length > 1) throw new Error("unsupported Codex policy shape");

  const allowIndexes = lines
    .map((line, index) => (/^\s*allow_implicit_invocation\s*:/.test(line) ? index : -1))
    .filter((index) => index >= 0);

  const policyIndex = policyIndexes[0];
  if (policyIndex === undefined) {
    if (allowIndexes.length > 0) {
      throw new Error("unsupported Codex allow_implicit_invocation placement");
    }
    return `${lines.join("\n")}\npolicy:\n  allow_implicit_invocation: false\n`;
  }

  if (!/^policy\s*:\s*(?:#.*)?$/.test(lines[policyIndex])) {
    throw new Error("unsupported Codex policy shape");
  }

  const policyEnd = findYamlTopLevelBlockEnd(lines, policyIndex);
  const childIndent = codexPolicyChildIndent(lines.slice(policyIndex + 1, policyEnd));
  const directAllowIndexes = allowIndexes.filter((index) => {
    if (index <= policyIndex || index >= policyEnd) return false;
    return (lines[index].match(/^\s*/)?.[0].length ?? 0) === childIndent.length;
  });
  if (directAllowIndexes.length !== allowIndexes.length || directAllowIndexes.length > 1) {
    throw new Error("unsupported Codex allow_implicit_invocation placement");
  }

  if (directAllowIndexes.length === 1) {
    const index = directAllowIndexes[0];
    lines[index] = `${childIndent}allow_implicit_invocation: false`;
  } else {
    lines.splice(policyIndex + 1, 0, `${childIndent}allow_implicit_invocation: false`);
  }
  return `${lines.join("\n")}\n`;
}

function findYamlTopLevelBlockEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (/^\S/.test(lines[i])) return i;
  }
  return lines.length;
}

function codexPolicyChildIndent(lines: string[]): string {
  const child = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const indent = child?.match(/^\s*/)?.[0];
  return indent && indent.length > 0 ? indent : "  ";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
