import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The agent whose folder a skill is moved in from (and restored back to). */
export type SkillSource = "claude" | "codex";

/**
 * Locations the skill manager moves between. `nativeDir` (Claude Code) and
 * `codexDir` (Codex) are where each agent auto-loads skills (always-on
 * metadata); `managedDir` is the Ratel-managed folder the gateway scans (loaded
 * on demand). The manifest records exactly which skills Ratel moved and from
 * where, so `deactivate` restores each — and only those — to its own agent.
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
  /** Absolute path the skill was moved *from* (where deactivate restores it). */
  originalPath: string;
  /** Which agent's folder it came from; restore targets this agent's dir.
   *  Optional for manifests written before multi-source support (treated as
   *  "claude", the only source that existed then). */
  source?: SkillSource;
  movedAt: string;
}

interface SkillManifest {
  version: 1;
  managed: ManagedEntry[];
}

export interface ManageOptions {
  logger?: (message: string) => void;
  /** When true, report what would move without touching the filesystem. */
  dryRun?: boolean;
  /** Restrict the operation to these skill ids. Omit to operate on all. */
  ids?: string[];
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export interface ActivateResult {
  moved: ManagedEntry[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface DeactivateResult {
  restored: ManagedEntry[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Move every native skill (a `<name>/SKILL.md` under `nativeDir`) into the
 * Ratel-managed folder, recording each in the manifest. Idempotent and
 * non-destructive: a name already present in `managedDir` is skipped, never
 * overwritten.
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

  // Persist the manifest after *each* move (atomically), so a crash or a failed
  // move mid-loop leaves a manifest that exactly reflects what's on disk — every
  // already-moved skill stays restorable by `deactivate`. The finally is a backstop
  // in case the throw was the manifest write itself.
  try {
    for (const { dir, source } of sources) {
      for (const id of await skillDirNames(dir)) {
        if (options.ids && !options.ids.includes(id)) continue;
        const from = join(dir, id);
        const to = join(paths.managedDir, id);
        if (already.has(id) || (await exists(to))) {
          skipped.push({ id, reason: "already present in managed folder" });
          log(`[ratel] skill ${id}: already managed — skipping`);
          continue;
        }
        if (options.dryRun) {
          log(`[ratel] would move skill ${id} (${source}) → ${paths.managedDir}`);
          moved.push({ id, originalPath: from, source, movedAt: now().toISOString() });
          already.add(id);
          continue;
        }
        await mkdir(paths.managedDir, { recursive: true });
        await moveDir(from, to);
        const entry: ManagedEntry = {
          id,
          originalPath: from,
          source,
          movedAt: now().toISOString(),
        };
        manifest.managed.push(entry);
        moved.push(entry);
        already.add(id);
        await writeManifest(paths.manifestPath, manifest);
        log(`[ratel] moved skill ${id} (${source}) → ${paths.managedDir}`);
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
 * Restore every skill the manifest recorded back to where it came from, then
 * clear those entries. Skills added directly to the managed folder (not in the
 * manifest) stay put. Idempotent: a missing skill or an occupied destination is
 * skipped, not clobbered.
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
      log(`[ratel] would restore skill ${entry.id} → ${dest}`);
      restored.push(entry);
      continue;
    }
    await mkdir(dirname(dest), { recursive: true });
    await moveDir(from, dest);
    restored.push(entry);
    log(`[ratel] restored skill ${entry.id} → ${dest}`);
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
    if (entry.isDirectory() && (await exists(join(dir, entry.name, "SKILL.md")))) {
      names.push(entry.name);
    }
  }
  return names;
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
