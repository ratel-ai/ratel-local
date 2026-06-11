import type { Dirent } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Locations the skill manager moves between. `nativeDir` is where Claude Code
 * auto-loads skills (always-on metadata); `managedDir` is the Ratel-managed
 * folder the gateway scans (loaded on demand). The manifest records exactly
 * which skills Ratel moved, so `deactivate` restores them — and only them.
 */
export interface SkillManagePaths {
  nativeDir: string;
  managedDir: string;
  manifestPath: string;
}

export function defaultSkillManagePaths(home: string = homedir()): SkillManagePaths {
  return {
    nativeDir: join(home, ".claude", "skills"),
    managedDir: join(home, ".ratel", "skills"),
    manifestPath: join(home, ".ratel", "skill-manifest.json"),
  };
}

export interface ManagedEntry {
  id: string;
  /** Absolute path the skill was moved *from* (where deactivate restores it). */
  originalPath: string;
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
  const already = new Set(manifest.managed.map((m) => m.id));

  const moved: ManagedEntry[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of await skillDirNames(paths.nativeDir)) {
    const from = join(paths.nativeDir, id);
    const to = join(paths.managedDir, id);
    if (already.has(id) || (await exists(to))) {
      skipped.push({ id, reason: "already present in managed folder" });
      log(`[ratel] skill ${id}: already managed — skipping`);
      continue;
    }
    if (options.dryRun) {
      log(`[ratel] would move skill ${id} → ${paths.managedDir}`);
      moved.push({ id, originalPath: from, movedAt: now().toISOString() });
      continue;
    }
    await mkdir(paths.managedDir, { recursive: true });
    await moveDir(from, to);
    const entry: ManagedEntry = { id, originalPath: from, movedAt: now().toISOString() };
    manifest.managed.push(entry);
    moved.push(entry);
    log(`[ratel] moved skill ${id} → ${paths.managedDir}`);
  }

  if (!options.dryRun && moved.length > 0) {
    await writeManifest(paths.manifestPath, manifest);
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
    if (!isSafeSkillId(entry.id)) {
      // The manifest is untrusted on read (stale cross-machine copy, corruption,
      // tampering). Never move based on an id that isn't a single safe segment.
      skipped.push({ id: String(entry.id), reason: "unsafe skill id in manifest" });
      remaining.push(entry);
      log(`[ratel] skill ${String(entry.id)}: unsafe id in manifest — leaving managed`);
      continue;
    }
    const from = join(paths.managedDir, entry.id);
    // Restore to the canonical native path derived from the id — do NOT trust the
    // manifest's `originalPath`, which can be stale (synced from another machine
    // with a different $HOME) or crafted to escape ~/.claude/skills.
    const dest = join(paths.nativeDir, entry.id);
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

  if (!options.dryRun) {
    await writeManifest(paths.manifestPath, { version: 1, managed: remaining });
  }
  return { restored, skipped };
}

/** Read the manifest of currently-managed skills (empty when none). */
export async function listManaged(paths: SkillManagePaths): Promise<ManagedEntry[]> {
  return (await readManifest(paths.manifestPath)).managed;
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

/** Move a directory, falling back to copy+remove across filesystems (EXDEV). */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

async function readManifest(path: string): Promise<SkillManifest> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SkillManifest>;
    return { version: 1, managed: Array.isArray(parsed.managed) ? parsed.managed : [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, managed: [] };
    throw err;
  }
}

async function writeManifest(path: string, manifest: SkillManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
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
