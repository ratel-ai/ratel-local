import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupFs } from "./backup.js";
import type { FileChange } from "./import-plan.js";
import { type JsonFs, nodeFs } from "./io.js";
import { createMutationEngine } from "./mutation-engine.js";
import { executePlan, executePlanTransactionally } from "./plan-exec.js";

const HOME = "/home/u";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  writeAtomicCalls: string[] = [];
  failNextWriteAt: string | null = null;

  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.writeAtomicCalls.push(p);
    if (this.failNextWriteAt === p) {
      this.failNextWriteAt = null;
      throw new Error(`fail-write-${p}`);
    }
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(p: string) {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names);
  }
}

const NOW = () => new Date("2026-05-03T12:00:00Z");

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("executePlan", () => {
  it("captures every original file before any writes happen, even files that don't exist yet", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "OLD");
    const changes: FileChange[] = [
      { kind: "write", path: "/a.json", before: "OLD\n", after: "A\n" },
      { kind: "write", path: "/b.json", before: null, after: "B\n" },
    ];
    const m = await executePlan(changes, {
      fs,
      env: { homeDir: HOME },
      action: "import",
      now: NOW,
    });
    expect(m.entries.find((e) => e.originalPath === "/a.json")?.existedBefore).toBe(true);
    expect(m.entries.find((e) => e.originalPath === "/b.json")?.existedBefore).toBe(false);
    expect(fs.files.get("/a.json")).toBe("A\n");
    expect(fs.files.get("/b.json")).toBe("B\n");
  });

  it("writes a manifest covering every change", async () => {
    const fs = new MemFs();
    const m = await executePlan([{ kind: "write", path: "/a.json", before: null, after: "A" }], {
      fs,
      env: { homeDir: HOME },
      action: "add",
      now: NOW,
    });
    expect(m.action).toBe("add");
    expect(m.entries.map((e) => e.originalPath)).toEqual(["/a.json"]);
  });

  it("rolls back already-written files when a later write fails", async () => {
    const fs = new MemFs();
    fs.files.set("/a.json", "OLD-A");
    fs.failNextWriteAt = "/b.json";
    await expect(
      executePlan(
        [
          { kind: "write", path: "/a.json", before: "OLD-A", after: "NEW-A" },
          { kind: "write", path: "/b.json", before: null, after: "NEW-B" },
        ],
        { fs, env: { homeDir: HOME }, action: "import", now: NOW },
      ),
    ).rejects.toThrow("fail-write-/b.json");
    expect(fs.files.get("/a.json")).toBe("OLD-A");
    expect(fs.files.has("/b.json")).toBe(false);
  });

  it("returns an empty manifest and writes nothing for a no-op plan", async () => {
    const fs = new MemFs();
    const m = await executePlan([], {
      fs,
      env: { homeDir: HOME },
      action: "import",
      now: NOW,
    });
    expect(m.entries).toEqual([]);
    expect(fs.writeAtomicCalls).toEqual([]);
  });

  it("rejects a plan that writes the same path twice", async () => {
    const fs = new MemFs();
    await expect(
      executePlan(
        [
          { kind: "write", path: "/a.json", before: null, after: "1" },
          { kind: "write", path: "/a.json", before: null, after: "2" },
        ],
        { fs, env: { homeDir: HOME }, action: "import", now: NOW },
      ),
    ).rejects.toThrow();
  });
});

describe("executePlanTransactionally", () => {
  it("rolls back every file when publishing a later write fails", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-plan-exec-"));
    tempRoots.push(homeDir);
    const firstPath = join(homeDir, "agent-a.json");
    const secondPath = join(homeDir, "agent-b.json");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await writeFile(firstPath, "OLD-A", "utf8");
    const engine = await createMutationEngine({
      controlDir: join(homeDir, ".ratel"),
      hooks: {
        beforeApplyOperation(_operation, index) {
          if (index === 1) throw new Error("stop-before-second-write");
        },
      },
    });

    await expect(
      executePlanTransactionally(
        [
          { kind: "write", path: firstPath, before: "OLD-A", after: "NEW-A" },
          { kind: "write", path: secondPath, before: null, after: "NEW-B" },
        ],
        { fs: nodeFs, env: { homeDir }, action: "import", mutationEngine: engine },
      ),
    ).rejects.toThrow("stop-before-second-write");

    expect(await readFile(firstPath, "utf8")).toBe("OLD-A");
    await expect(readFile(secondPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(homeDir, ".ratel", "transactions"))).toEqual([]);
  });

  it("rejects a stale FileChange snapshot without overwriting the newer file", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-plan-exec-"));
    tempRoots.push(homeDir);
    const targetPath = join(homeDir, "agent.json");
    await writeFile(targetPath, "EDITED-AFTER-PLAN", "utf8");

    await expect(
      executePlanTransactionally(
        [{ kind: "write", path: targetPath, before: "ORIGINAL", after: "STALE-OUTPUT" }],
        { fs: nodeFs, env: { homeDir }, action: "link" },
      ),
    ).rejects.toMatchObject({ reason: "revision_conflict", path: targetPath });

    expect(await readFile(targetPath, "utf8")).toBe("EDITED-AFTER-PLAN");
  });

  it("does not normalize an invalid external MCP edit into the expected empty object", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-plan-exec-"));
    tempRoots.push(homeDir);
    const targetPath = join(homeDir, "config.json");
    const invalidEdit = JSON.stringify({ mcpServers: "manual-invalid-edit" });
    await writeFile(targetPath, invalidEdit, "utf8");

    await expect(
      executePlanTransactionally(
        [
          {
            kind: "write",
            path: targetPath,
            before: JSON.stringify({ mcpServers: {} }),
            after: JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
          },
        ],
        { fs: nodeFs, env: { homeDir }, action: "import" },
      ),
    ).rejects.toMatchObject({ reason: "revision_conflict", path: targetPath });

    expect(await readFile(targetPath, "utf8")).toBe(invalidEdit);
  });

  it("ties a semantic-equivalence reread to the bytes hashed by engine preview", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-plan-exec-"));
    tempRoots.push(homeDir);
    const targetPath = join(homeDir, "config.json");
    const expected = JSON.stringify({ mcpServers: {} });
    const externalEdit = JSON.stringify({
      mcpServers: { external: { type: "stdio", command: "do-not-overwrite" } },
    });
    await writeFile(targetPath, externalEdit, "utf8");
    const readSpy = vi.spyOn(nodeFs, "read").mockResolvedValueOnce(expected);
    try {
      await expect(
        executePlanTransactionally(
          [
            {
              kind: "write",
              path: targetPath,
              before: expected,
              after: JSON.stringify({ mcpServers: { ratel: { command: "ratel-local" } } }),
            },
          ],
          { fs: nodeFs, env: { homeDir }, action: "link" },
        ),
      ).rejects.toMatchObject({ reason: "revision_conflict", path: targetPath });
    } finally {
      readSpy.mockRestore();
    }

    expect(await readFile(targetPath, "utf8")).toBe(externalEdit);
  });

  it("requires an explicit legacy executor for a non-native filesystem", async () => {
    const fs = new MemFs();
    await expect(
      executePlanTransactionally(
        [{ kind: "write", path: "/agent.json", before: null, after: "new" }],
        { fs, env: { homeDir: HOME }, action: "link" },
      ),
    ).rejects.toThrow(/requires nodeFs/);
    expect(fs.files.has("/agent.json")).toBe(false);
  });
});
