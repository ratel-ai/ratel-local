import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { skillStorageEnabled } from "./feature-flags.js";
import type { HierarchyEnv } from "./hierarchy.js";

export interface BackupFs {
  read(path: string): Promise<string | null>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  list(path: string): Promise<string[]>;
}

export interface BackupEntry {
  originalPath: string;
  backupPath: string;
  existedBefore: boolean;
  kind?: "file" | "dir" | "symlink";
  digest?: string;
  target?: string;
  mode?: number;
  mtime?: string;
}

export interface BackupManifest {
  /** Directory name under ~/.ratel/backups/. */
  id: string;
  createdAt: string;
  action: "import" | "add" | "remove" | "edit" | "link" | "migrate" | "duplicate" | "cloud-update";
  source?: string;
  entries: BackupEntry[];
}

export interface BackupSession {
  dir: string;
  capture(originalPath: string): Promise<void>;
  finalize(action: BackupManifest["action"]): Promise<BackupManifest>;
}

const MANIFEST = "manifest.json";

function backupsRoot(env: HierarchyEnv): string {
  return join(env.homeDir, ".ratel", "backups");
}

function safeStamp(d: Date): string {
  return d.toISOString().replace(/:/g, "-");
}

/** Suffixed: two captures in the same millisecond must not share a directory. */
function snapshotId(now: () => Date): string {
  return `${safeStamp(now())}-${randomUUID().slice(0, 8)}`;
}

function backupFileName(originalPath: string): string {
  const hash = createHash("sha1").update(originalPath).digest("hex").slice(0, 12);
  return `${hash}-${basename(originalPath)}`;
}

export function startBackup(
  env: HierarchyEnv,
  fs: BackupFs,
  now: () => Date = () => new Date(),
): BackupSession {
  const id = snapshotId(now);
  const dir = join(backupsRoot(env), id);
  const captured = new Map<string, BackupEntry>();
  let dirCreated = false;

  async function ensureDir() {
    if (dirCreated) return;
    await fs.mkdirp(dir);
    dirCreated = true;
  }

  return {
    dir,
    async capture(originalPath: string) {
      if (captured.has(originalPath)) return;
      await ensureDir();
      const backupPath = join(dir, backupFileName(originalPath));
      const before = await fs.read(originalPath);
      const existedBefore = before !== null;
      if (existedBefore) {
        await fs.write(backupPath, before as string);
      }
      captured.set(originalPath, { originalPath, backupPath, existedBefore });
    },
    async finalize(action) {
      await ensureDir();
      const manifest: BackupManifest = {
        id,
        createdAt: now().toISOString(),
        action,
        entries: Array.from(captured.values()),
      };
      await fs.write(join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
      return manifest;
    },
  };
}

export async function listBackups(env: HierarchyEnv, fs: BackupFs): Promise<BackupManifest[]> {
  const root = backupsRoot(env);
  const subdirs = await fs.list(root).catch(() => []);
  const manifests: { name: string; manifest: BackupManifest }[] = [];
  for (const name of subdirs) {
    const text = await fs.read(join(root, name, MANIFEST));
    if (text === null) continue;
    try {
      manifests.push({ name, manifest: JSON.parse(text) as BackupManifest });
    } catch {
      // ignore unreadable manifest
    }
  }
  manifests.sort((a, b) => (a.name < b.name ? 1 : -1));
  return manifests.map((m) => m.manifest);
}

export interface SnapshotRequest {
  action: BackupManifest["action"];
  paths: readonly string[];
  source?: string;
}

export async function captureSnapshot(
  env: HierarchyEnv,
  request: SnapshotRequest,
  now: () => Date = () => new Date(),
): Promise<BackupManifest> {
  const id = snapshotId(now);
  const dir = join(backupsRoot(env), id);
  await mkdir(dir, { recursive: true });
  const entries: BackupEntry[] = [];
  const seen = new Set<string>();
  for (const originalPath of request.paths) {
    if (seen.has(originalPath)) continue;
    seen.add(originalPath);
    await captureNode(originalPath, join(dir, backupFileName(originalPath)), entries);
  }
  const manifest: BackupManifest = {
    id,
    createdAt: now().toISOString(),
    action: request.action,
    ...(request.source === undefined ? {} : { source: request.source }),
    entries,
  };
  // Written last: an interrupted capture leaves directory
  // without manifest, which listBackups skips.
  const manifestPath = join(dir, MANIFEST);
  const temporaryPath = `${manifestPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(temporaryPath, manifestPath);
  return manifest;
}

/** Snapshot when the new Skill filesystem is on, flat per-file copies otherwise. */
export async function captureOperationBackup(
  env: HierarchyEnv,
  fs: BackupFs,
  request: SnapshotRequest,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<BackupManifest> {
  if (skillStorageEnabled(processEnv)) return captureSnapshot(env, request);
  const session = startBackup(env, fs);
  for (const path of request.paths) await session.capture(path);
  return session.finalize(request.action);
}

async function captureNode(
  originalPath: string,
  backupPath: string,
  entries: BackupEntry[],
): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(originalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    entries.push({ originalPath, backupPath, existedBefore: false });
    return;
  }
  const mode = info.mode & 0o7777;
  const mtime = info.mtime.toISOString();
  const entry: BackupEntry = { originalPath, backupPath, existedBefore: true, mode, mtime };

  if (info.isSymbolicLink()) {
    const target = await readlink(originalPath);
    await symlink(target, backupPath);
    entries.push({ ...entry, kind: "symlink", target });
    return;
  }
  if (info.isDirectory()) {
    await mkdir(backupPath, { recursive: true });
    entries.push({ ...entry, kind: "dir" });
    for (const name of (await readdir(originalPath)).sort()) {
      await captureNode(join(originalPath, name), join(backupPath, name), entries);
    }
    await chmod(backupPath, mode);
    return;
  }
  await copyFile(originalPath, backupPath);
  await chmod(backupPath, mode);
  entries.push({
    ...entry,
    kind: "file",
    digest: createHash("sha256")
      .update(await readFile(backupPath))
      .digest("hex"),
  });
}
