import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateSkills, deactivateSkills, listManaged, type SkillManagePaths } from "./manage.js";

let home: string;
let paths: SkillManagePaths;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ratel-manage-"));
  paths = {
    nativeDir: join(home, ".claude", "skills"),
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

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

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

  it("does nothing when there is no manifest", async () => {
    const result = await deactivateSkills(paths);
    expect(result.restored).toEqual([]);
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
