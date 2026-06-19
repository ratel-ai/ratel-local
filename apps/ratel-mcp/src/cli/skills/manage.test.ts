import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateSkills,
  deactivateSkills,
  deleteManagedSkill,
  listManaged,
  type SkillManagePaths,
  SkillManifestError,
} from "./manage.js";

let home: string;
let paths: SkillManagePaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ratel-manage-"));
  paths = {
    nativeDir: join(home, ".claude", "skills"),
    codexDir: join(home, ".codex", "skills"),
    managedDir: join(home, ".ratel", "skills"),
    manifestPath: join(home, ".ratel", "skill-manifest.json"),
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeNativeSkill(name: string, body = "# body"): Promise<void> {
  const dir = join(paths.nativeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

async function writeCodexSkill(name: string, body = "# body"): Promise<void> {
  const dir = join(paths.codexDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

describe("deleteManagedSkill", () => {
  async function writeManagedSkill(name: string): Promise<void> {
    const dir = join(paths.managedDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n# x`);
  }

  it("removes a Ratel-created skill folder (no manifest entry)", async () => {
    await writeManagedSkill("my-skill");
    const removed = await deleteManagedSkill(paths, "my-skill");
    expect(removed).toBe(true);
    expect(await exists(join(paths.managedDir, "my-skill", "SKILL.md"))).toBe(false);
  });

  it("drops the manifest entry for an activated skill it deletes", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths, {});
    expect((await listManaged(paths)).map((m) => m.id)).toContain("api-design");
    await deleteManagedSkill(paths, "api-design");
    expect((await listManaged(paths)).map((m) => m.id)).not.toContain("api-design");
  });

  it("returns false for an unknown skill and rejects unsafe ids", async () => {
    expect(await deleteManagedSkill(paths, "ghost")).toBe(false);
    await expect(deleteManagedSkill(paths, "../escape")).rejects.toThrow(/unsafe/);
  });
});

describe("activateSkills", () => {
  it("moves native skills into the managed folder and records a manifest", async () => {
    await writeNativeSkill("api-design");
    await writeNativeSkill("slides");

    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id).sort()).toEqual(["api-design", "slides"]);

    // moved out of native, into managed
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(false);
    expect(await exists(join(paths.managedDir, "api-design", "SKILL.md"))).toBe(true);

    const managed = await listManaged(paths);
    expect(managed.map((m) => m.id).sort()).toEqual(["api-design", "slides"]);
    expect(managed[0].originalPath).toContain(join(".claude", "skills"));
  });

  it("is idempotent — a second activate moves nothing new", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    const second = await activateSkills(paths);
    expect(second.moved).toEqual([]);
  });

  it("skips (never overwrites) a name already present in the managed folder", async () => {
    await writeNativeSkill("dup");
    await mkdir(join(paths.managedDir, "dup"), { recursive: true });
    await writeFile(join(paths.managedDir, "dup", "SKILL.md"), "existing managed copy");

    const result = await activateSkills(paths);
    expect(result.moved).toEqual([]);
    expect(result.skipped[0]?.id).toBe("dup");
    // the native copy is left untouched
    expect(await exists(join(paths.nativeDir, "dup", "SKILL.md"))).toBe(true);
  });

  it("ignores subdirectories without a SKILL.md", async () => {
    await mkdir(join(paths.nativeDir, "not-a-skill"), { recursive: true });
    await writeNativeSkill("real");
    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id)).toEqual(["real"]);
  });

  it("dry-run reports moves without touching the filesystem", async () => {
    await writeNativeSkill("api-design");
    const result = await activateSkills(paths, { dryRun: true });
    expect(result.moved.map((m) => m.id)).toEqual(["api-design"]);
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "api-design", "SKILL.md"))).toBe(false);
    expect(await exists(paths.manifestPath)).toBe(false);
  });

  it("with `ids` activates only the selected skills", async () => {
    await writeNativeSkill("alpha");
    await writeNativeSkill("beta");
    const result = await activateSkills(paths, { ids: ["alpha"] });
    expect(result.moved.map((m) => m.id)).toEqual(["alpha"]);
    expect(await exists(join(paths.managedDir, "alpha", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "beta"))).toBe(false);
    expect(await exists(join(paths.nativeDir, "beta", "SKILL.md"))).toBe(true);
  });

  it("moves Codex skills into the managed folder and records source=codex", async () => {
    await writeCodexSkill("from-codex");
    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id)).toEqual(["from-codex"]);
    expect(await exists(join(paths.codexDir, "from-codex", "SKILL.md"))).toBe(false);
    expect(await exists(join(paths.managedDir, "from-codex", "SKILL.md"))).toBe(true);
    expect((await listManaged(paths)).find((m) => m.id === "from-codex")?.source).toBe("codex");
  });

  it("takes a name present in both agents from Claude and skips the Codex copy", async () => {
    await writeNativeSkill("shared");
    await writeCodexSkill("shared");
    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id)).toEqual(["shared"]);
    expect((await listManaged(paths)).find((m) => m.id === "shared")?.source).toBe("claude");
    expect(result.skipped.map((s) => s.id)).toContain("shared");
    // the Codex copy is left untouched
    expect(await exists(join(paths.codexDir, "shared", "SKILL.md"))).toBe(true);
  });

  it("with source=codex activates the Codex copy of a shared name, leaving Claude's", async () => {
    await writeNativeSkill("shared");
    await writeCodexSkill("shared");
    const result = await activateSkills(paths, { ids: ["shared"], source: "codex" });
    expect(result.moved.map((m) => m.id)).toEqual(["shared"]);
    expect((await listManaged(paths)).find((m) => m.id === "shared")?.source).toBe("codex");
    // Codex copy moved out; Claude copy stays put.
    expect(await exists(join(paths.codexDir, "shared", "SKILL.md"))).toBe(false);
    expect(await exists(join(paths.nativeDir, "shared", "SKILL.md"))).toBe(true);
  });
});

describe("deactivateSkills", () => {
  it("restores managed skills back to their original location and clears the manifest", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);

    const result = await deactivateSkills(paths);
    expect(result.restored.map((m) => m.id)).toEqual(["api-design"]);
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "api-design"))).toBe(false);
    expect(await listManaged(paths)).toEqual([]);
  });

  it("leaves a skill managed when its original destination is already occupied", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    // user re-created a native skill with the same name
    await writeNativeSkill("api-design", "# recreated");

    const result = await deactivateSkills(paths);
    expect(result.restored).toEqual([]);
    expect(result.skipped[0]?.id).toBe("api-design");
    // still managed, manifest preserved
    expect((await listManaged(paths)).map((m) => m.id)).toEqual(["api-design"]);
  });

  it("only restores skills it moved, leaving manually-added managed skills in place", async () => {
    await writeNativeSkill("moved");
    await activateSkills(paths);
    // a skill the user authored directly in the managed folder
    await mkdir(join(paths.managedDir, "hand-authored"), { recursive: true });
    await writeFile(join(paths.managedDir, "hand-authored", "SKILL.md"), "# direct");

    await deactivateSkills(paths);
    expect(await exists(join(paths.nativeDir, "moved", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.nativeDir, "hand-authored"))).toBe(false);
    expect(await exists(join(paths.managedDir, "hand-authored", "SKILL.md"))).toBe(true);
  });

  it("restores a Codex-sourced skill to the Codex folder, not Claude's", async () => {
    await writeCodexSkill("from-codex");
    await activateSkills(paths);
    const result = await deactivateSkills(paths);
    expect(result.restored.map((m) => m.id)).toEqual(["from-codex"]);
    expect(await exists(join(paths.codexDir, "from-codex", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.nativeDir, "from-codex"))).toBe(false);
    expect(await exists(join(paths.managedDir, "from-codex"))).toBe(false);
  });

  it("restores a sourceless (legacy) manifest entry to Claude", async () => {
    await writeNativeSkill("legacy");
    await activateSkills(paths);
    // Simulate a manifest written before multi-source support (no `source`).
    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8")) as {
      managed: Array<Record<string, unknown>>;
    };
    for (const entry of manifest.managed) delete entry.source;
    await writeFile(paths.manifestPath, JSON.stringify(manifest));

    const result = await deactivateSkills(paths);
    expect(result.restored.map((m) => m.id)).toEqual(["legacy"]);
    expect(await exists(join(paths.nativeDir, "legacy", "SKILL.md"))).toBe(true);
  });

  it("does nothing when there is no manifest", async () => {
    const result = await deactivateSkills(paths);
    expect(result.restored).toEqual([]);
  });

  it("with `ids` deactivates only the selected skills", async () => {
    await writeNativeSkill("alpha");
    await writeNativeSkill("beta");
    await activateSkills(paths);
    const result = await deactivateSkills(paths, { ids: ["alpha"] });
    expect(result.restored.map((m) => m.id)).toEqual(["alpha"]);
    expect(await exists(join(paths.nativeDir, "alpha", "SKILL.md"))).toBe(true);
    expect((await listManaged(paths)).map((m) => m.id)).toEqual(["beta"]);
  });

  it("restores to the canonical native path, ignoring a stale/crafted originalPath (#7)", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    // Tamper the manifest: point originalPath outside ~/.claude/skills (e.g. a
    // different machine's $HOME, or a crafted escape).
    const evil = join(home, "evil-target");
    await writeFile(
      paths.manifestPath,
      JSON.stringify({
        version: 1,
        managed: [{ id: "api-design", originalPath: join(evil, "api-design"), movedAt: "x" }],
      }),
    );

    await deactivateSkills(paths);
    // Restored to the canonical native dir, NOT the crafted path.
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(true);
    expect(await exists(join(evil, "api-design", "SKILL.md"))).toBe(false);
  });

  it("skips a manifest entry whose id is not a safe path segment (#7)", async () => {
    await mkdir(paths.managedDir, { recursive: true });
    await writeFile(
      paths.manifestPath,
      JSON.stringify({
        version: 1,
        managed: [{ id: "../escape", originalPath: "/tmp/x", movedAt: "x" }],
      }),
    );

    const result = await deactivateSkills(paths);
    expect(result.restored).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/unsafe/);
  });
});

describe("activate/deactivate round-trip", () => {
  it("returns the tree to its starting shape", async () => {
    await writeNativeSkill("a");
    await writeNativeSkill("b");

    await activateSkills(paths);
    await deactivateSkills(paths);

    expect(await exists(join(paths.nativeDir, "a", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.nativeDir, "b", "SKILL.md"))).toBe(true);
    expect(await listManaged(paths)).toEqual([]);
  });
});

describe("manifest integrity", () => {
  async function writeManifestRaw(text: string): Promise<void> {
    await mkdir(join(home, ".ratel"), { recursive: true });
    await writeFile(paths.manifestPath, text);
  }

  it("persists the manifest per move (a moved skill is recorded immediately)", async () => {
    await writeNativeSkill("a");
    await activateSkills(paths);
    // manifest on disk is valid JSON and lists the move (atomic write left no temp)
    const onDisk = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    expect(onDisk.managed.map((m: { id: string }) => m.id)).toEqual(["a"]);
  });

  it("refuses to proceed on a corrupt manifest instead of silently emptying it", async () => {
    await writeManifestRaw("{ this is not json");
    await expect(listManaged(paths)).rejects.toBeInstanceOf(SkillManifestError);
    await expect(activateSkills(paths)).rejects.toBeInstanceOf(SkillManifestError);
    await expect(deactivateSkills(paths)).rejects.toBeInstanceOf(SkillManifestError);
  });

  it("preserves a malformed entry and still restores the valid siblings", async () => {
    // one valid managed skill (present in managedDir) + one malformed entry
    await mkdir(join(paths.managedDir, "good"), { recursive: true });
    await writeFile(join(paths.managedDir, "good", "SKILL.md"), "# good");
    await writeManifestRaw(
      JSON.stringify({
        version: 1,
        managed: [
          { id: "good", originalPath: join(paths.nativeDir, "good"), movedAt: "t" },
          { nonsense: true },
        ],
      }),
    );

    const result = await deactivateSkills(paths);
    expect(result.restored.map((r) => r.id)).toEqual(["good"]);
    expect(await exists(join(paths.nativeDir, "good", "SKILL.md"))).toBe(true);
    // the malformed entry is kept (not lost), the valid one cleared
    const remaining = JSON.parse(await readFile(paths.manifestPath, "utf8")).managed;
    expect(remaining).toEqual([{ nonsense: true }]);
  });
});
