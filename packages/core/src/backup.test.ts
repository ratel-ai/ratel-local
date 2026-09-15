import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupEntry, BackupManifest } from "./backup.js";
import { captureSnapshot, listBackups, startBackup } from "./backup.js";

const HOME = "/home/u";

class MemFs {
  files = new Map<string, string>();
  dirs = new Set<string>();

  async read(p: string): Promise<string | null> {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p);
  }
  async mkdirp(p: string): Promise<void> {
    this.dirs.add(p);
  }
  async list(p: string): Promise<string[]> {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names).sort();
  }
}

const stableNow = (i: number) => new Date(`2026-05-03T12:0${i}:00Z`);

describe("startBackup + finalize", () => {
  it("creates a timestamped backup dir under ~/.ratel/backups and copies captured files in", async () => {
    const fs = new MemFs();
    fs.files.set("/etc/foo.json", '{"a":1}');
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/etc/foo.json");
    const manifest = await session.finalize("add");

    expect(session.dir.startsWith("/home/u/.ratel/backups/")).toBe(true);
    expect(session.dir).not.toContain(":");
    expect(manifest.action).toBe("add");
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0];
    expect(entry.originalPath).toBe("/etc/foo.json");
    expect(entry.existedBefore).toBe(true);
    expect(fs.files.get(entry.backupPath)).toBe('{"a":1}');
  });

  it("records existedBefore=false for a captured path that doesn't exist", async () => {
    const fs = new MemFs();
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/etc/missing.json");
    const m = await session.finalize("import");
    expect(m.entries[0].existedBefore).toBe(false);
  });

  it("writes a manifest.json listing every captured file", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "A");
    fs.files.set("/b.json", "B");
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(1));
    await session.capture("/a.json");
    await session.capture("/b.json");
    const m = await session.finalize("import");
    const onDisk = JSON.parse((await fs.read(`${session.dir}/manifest.json`)) as string);
    expect(onDisk).toEqual(m);
    expect(m.entries.map((e) => e.originalPath).sort()).toEqual(["/a.json", "/b.json"]);
  });

  it("is idempotent on a double-capture of the same path within one session", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "first");
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await session.capture("/a.json");
    fs.files.set("/a.json", "second"); // simulate change
    await session.capture("/a.json");
    const m = await session.finalize("add");
    expect(m.entries).toHaveLength(1);
    expect(fs.files.get(m.entries[0].backupPath)).toBe("first");
  });

  it("names the manifest id after its own directory", async () => {
    const fs = new MemFs();
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    const m = await session.finalize("add");
    expect(session.dir).toBe(`/home/u/.ratel/backups/${m.id}`);
  });

  it("gives two sessions started in the same instant distinct directories", async () => {
    const fs = new MemFs();
    const first = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    const second = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    expect(first.dir).not.toBe(second.dir);
  });

  it("uses a filesystem-safe ISO timestamp (no colons) for the dir name", async () => {
    const fs = new MemFs();
    const session = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    expect(session.dir).not.toContain(":");
  });
});

describe("listBackups", () => {
  it("returns an empty list when no backups exist", async () => {
    const fs = new MemFs();
    expect(await listBackups({ homeDir: HOME }, fs)).toEqual([]);
  });

  it("returns manifests sorted newest-first", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "A");
    fs.files.set("/b.json", "B");
    const s1 = startBackup({ homeDir: HOME }, fs, () => stableNow(0));
    await s1.capture("/a.json");
    await s1.finalize("import");
    const s2 = startBackup({ homeDir: HOME }, fs, () => stableNow(1));
    await s2.capture("/b.json");
    await s2.finalize("add");

    const list = await listBackups({ homeDir: HOME }, fs);
    expect(list).toHaveLength(2);
    expect(list[0].action).toBe("add");
    expect(list[1].action).toBe("import");
  });

  it("ignores backup directories that have no manifest", async () => {
    const fs = new MemFs();
    fs.files.set("/home/u/.ratel/backups/abandoned/something.txt", "x");
    expect(await listBackups({ homeDir: HOME }, fs)).toEqual([]);
  });
});

describe("captureSnapshot", () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ratel-snapshot-"));
    home = join(root, "home");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const BINARY = Buffer.from([0x00, 0xff, 0x1b, 0x00, 0x7f, 0xc3, 0x28]);

  async function buildTree(): Promise<string> {
    const tree = join(root, "tree");
    const outside = join(root, "outside");
    await mkdir(join(tree, "nested"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(tree, "nested", "inner.txt"), "inner\n");
    await writeFile(join(tree, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await writeFile(join(tree, "blob.bin"), BINARY);
    await writeFile(join(outside, "secret.txt"), "not mine\n");
    await symlink(outside, join(tree, "link"));
    return tree;
  }

  const byPath = (m: BackupManifest, p: string) =>
    m.entries.find((e) => e.originalPath === p) as BackupEntry;

  it("reproduces a nested dir, a symlink, an executable and a binary file", async () => {
    const tree = await buildTree();
    const manifest = await captureSnapshot({ homeDir: home }, { action: "import", paths: [tree] });

    const dir = byPath(manifest, tree);
    expect(dir.kind).toBe("dir");

    const nested = byPath(manifest, join(tree, "nested", "inner.txt"));
    expect(nested.kind).toBe("file");
    expect(await readFile(nested.backupPath, "utf8")).toBe("inner\n");

    const exec = byPath(manifest, join(tree, "run.sh"));
    expect(exec.mode).toBe(0o755);
    expect((await lstat(exec.backupPath)).mode & 0o7777).toBe(0o755);

    const blob = byPath(manifest, join(tree, "blob.bin"));
    expect(await readFile(blob.backupPath)).toEqual(BINARY);
    expect(blob.digest).toBe(createHash("sha256").update(BINARY).digest("hex"));

    const link = byPath(manifest, join(tree, "link"));
    expect(link.kind).toBe("symlink");
    expect(link.target).toBe(join(root, "outside"));
    expect((await lstat(link.backupPath)).isSymbolicLink()).toBe(true);
  });

  it("records every captured entry with its type and digest", async () => {
    const tree = await buildTree();
    const manifest = await captureSnapshot({ homeDir: home }, { action: "import", paths: [tree] });

    expect(manifest.entries.map((e) => e.originalPath).sort()).toEqual(
      [
        tree,
        join(tree, "blob.bin"),
        join(tree, "link"),
        join(tree, "nested"),
        join(tree, "nested", "inner.txt"),
        join(tree, "run.sh"),
      ].sort(),
    );
    for (const entry of manifest.entries) {
      expect(entry.kind).toBeDefined();
      expect(entry.digest === undefined).toBe(entry.kind !== "file");
    }
  });

  it("captures a symlink as a link without walking its target", async () => {
    const tree = await buildTree();
    const manifest = await captureSnapshot({ homeDir: home }, { action: "import", paths: [tree] });

    expect(manifest.entries.some((e) => e.originalPath.includes("secret.txt"))).toBe(false);
    await expect(readdir(join(tree, "link"))).resolves.toEqual(["secret.txt"]);
  });

  it("records a missing path instead of failing", async () => {
    const manifest = await captureSnapshot(
      { homeDir: home },
      { action: "remove", paths: [join(root, "gone")] },
    );
    expect(manifest.entries).toEqual([
      { originalPath: join(root, "gone"), backupPath: expect.any(String), existedBefore: false },
    ]);
  });

  it("addresses a snapshot by an id unique to two captures in the same instant", async () => {
    const tree = await buildTree();
    const at = () => new Date("2026-05-03T12:00:00Z");
    const first = await captureSnapshot({ homeDir: home }, { action: "import", paths: [tree] }, at);
    const second = await captureSnapshot(
      { homeDir: home },
      { action: "import", paths: [tree] },
      at,
    );

    expect(first.id).not.toBe(second.id);
    for (const m of [first, second]) {
      expect(dirname(m.entries[0].backupPath)).toBe(join(home, ".ratel", "backups", m.id));
      await expect(
        readFile(join(home, ".ratel", "backups", m.id, "manifest.json"), "utf8"),
      ).resolves.toContain(m.id);
    }
  });

  it("leaves no partial manifest behind: it is renamed into place", async () => {
    const tree = await buildTree();
    const manifest = await captureSnapshot({ homeDir: home }, { action: "import", paths: [tree] });
    const dir = join(home, ".ratel", "backups", manifest.id);
    expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("writes the manifest last, so an interrupted capture has none to find", async () => {
    const tree = await buildTree();
    await rm(join(tree, "nested"), { recursive: true });
    await symlink("/nowhere/at/all", join(tree, "nested")); // dangling, still captured
    const manifest = await captureSnapshot(
      { homeDir: home },
      { action: "import", paths: [tree], source: "/some/origin" },
    );
    expect(manifest.source).toBe("/some/origin");
    const dir = dirname(manifest.entries[0].backupPath);
    expect(JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))).toEqual(manifest);
  });
});
