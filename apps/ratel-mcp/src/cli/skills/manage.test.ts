import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateSkills,
  deactivateSkills,
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

describe("activateSkills", () => {
  it("links native skills into the managed folder and records a manifest", async () => {
    await writeNativeSkill("api-design");
    await writeNativeSkill("slides");

    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id).sort()).toEqual(["api-design", "slides"]);

    // native stays in place, managed folder gets a symlink
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "api-design", "SKILL.md"))).toBe(true);
    expect((await lstat(join(paths.managedDir, "api-design"))).isSymbolicLink()).toBe(true);

    const managed = await listManaged(paths);
    expect(managed.map((m) => m.id).sort()).toEqual(["api-design", "slides"]);
    expect(managed[0].mode).toBe("linked");
    expect(managed[0].originalPath).toContain(join(".claude", "skills"));
    expect(await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
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

  it("rolls back the managed link when metadata patching fails", async () => {
    const dir = join(paths.nativeDir, "broken");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "# missing frontmatter");

    const result = await activateSkills(paths);

    expect(result.moved).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      id: "broken",
      reason: expect.stringMatching(/manual-only metadata/i),
    });
    expect(await exists(join(paths.managedDir, "broken"))).toBe(false);
    expect(await exists(paths.manifestPath)).toBe(false);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe("# missing frontmatter");
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

  it("links Codex skills into the managed folder and records source=codex", async () => {
    await writeCodexSkill("from-codex");
    const result = await activateSkills(paths);
    expect(result.moved.map((m) => m.id)).toEqual(["from-codex"]);
    expect(await exists(join(paths.codexDir, "from-codex", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "from-codex", "SKILL.md"))).toBe(true);
    expect((await listManaged(paths)).find((m) => m.id === "from-codex")?.source).toBe("codex");
    expect(
      await readFile(join(paths.codexDir, "from-codex", "agents", "openai.yaml"), "utf8"),
    ).toContain("allow_implicit_invocation: false");
  });

  it("updates Codex block policy without disturbing sibling policy keys", async () => {
    await writeCodexSkill("block-policy");
    const policyPath = join(paths.codexDir, "block-policy", "agents", "openai.yaml");
    await mkdir(join(paths.codexDir, "block-policy", "agents"), { recursive: true });
    await writeFile(policyPath, "policy:\n  allow_implicit_invocation: true\n  review: manual\n");

    const result = await activateSkills(paths, { source: "codex" });

    expect(result.moved.map((m) => m.id)).toEqual(["block-policy"]);
    expect(await readFile(policyPath, "utf8")).toBe(
      "policy:\n  allow_implicit_invocation: false\n  review: manual\n",
    );
  });

  it("skips Codex skills with flow-style policy instead of corrupting openai.yaml", async () => {
    await writeCodexSkill("flow-policy");
    const policyPath = join(paths.codexDir, "flow-policy", "agents", "openai.yaml");
    await mkdir(join(paths.codexDir, "flow-policy", "agents"), { recursive: true });
    await writeFile(policyPath, "policy: { allow_implicit_invocation: true, review: manual }\n");

    const result = await activateSkills(paths, { source: "codex" });

    expect(result.moved).toEqual([]);
    expect(result.skipped[0]).toMatchObject({
      id: "flow-policy",
      reason: expect.stringMatching(/unsupported/i),
    });
    expect(await readFile(policyPath, "utf8")).toBe(
      "policy: { allow_implicit_invocation: true, review: manual }\n",
    );
    expect(await exists(join(paths.managedDir, "flow-policy"))).toBe(false);
    expect(await listManaged(paths)).toEqual([]);
  });

  it("skips Codex skills with top-level allow_implicit_invocation", async () => {
    await writeCodexSkill("top-level-allow");
    const policyPath = join(paths.codexDir, "top-level-allow", "agents", "openai.yaml");
    await mkdir(join(paths.codexDir, "top-level-allow", "agents"), { recursive: true });
    await writeFile(policyPath, "allow_implicit_invocation: true\n");

    const result = await activateSkills(paths, { source: "codex" });

    expect(result.moved).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/unsupported/i);
    expect(await readFile(policyPath, "utf8")).toBe("allow_implicit_invocation: true\n");
    expect(await exists(join(paths.managedDir, "top-level-allow"))).toBe(false);
  });

  it("skips Codex skills with nested allow_implicit_invocation outside policy", async () => {
    await writeCodexSkill("nested-allow");
    const policyPath = join(paths.codexDir, "nested-allow", "agents", "openai.yaml");
    await mkdir(join(paths.codexDir, "nested-allow", "agents"), { recursive: true });
    await writeFile(policyPath, "profiles:\n  default:\n    allow_implicit_invocation: true\n");

    const result = await activateSkills(paths, { source: "codex" });

    expect(result.moved).toEqual([]);
    expect(result.skipped[0]?.reason).toMatch(/unsupported/i);
    expect(await readFile(policyPath, "utf8")).toBe(
      "profiles:\n  default:\n    allow_implicit_invocation: true\n",
    );
    expect(await exists(join(paths.managedDir, "nested-allow"))).toBe(false);
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
    // both native copies stay put; the managed slot links to Codex.
    expect(await exists(join(paths.codexDir, "shared", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.nativeDir, "shared", "SKILL.md"))).toBe(true);
  });
});

describe("deactivateSkills", () => {
  it("removes linked managed skills and clears the manifest", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);

    const result = await deactivateSkills(paths);
    expect(result.restored.map((m) => m.id)).toEqual(["api-design"]);
    expect(await exists(join(paths.nativeDir, "api-design", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.managedDir, "api-design"))).toBe(false);
    expect(await listManaged(paths)).toEqual([]);
    expect(await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  it("restores only Ratel metadata when it is unchanged", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    await deactivateSkills(paths);
    expect(await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8")).toBe(
      "---\nname: api-design\ndescription: d\n---\n# body",
    );
  });

  it("restores native metadata even if the managed link is missing", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    await rm(join(paths.managedDir, "api-design"), { recursive: true, force: true });

    const result = await deactivateSkills(paths);

    expect(result.restored.map((m) => m.id)).toEqual(["api-design"]);
    expect(await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8")).toBe(
      "---\nname: api-design\ndescription: d\n---\n# body",
    );
    expect(await listManaged(paths)).toEqual([]);
  });

  it("preserves user metadata edits made after activation", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    await writeFile(
      join(paths.nativeDir, "api-design", "SKILL.md"),
      "---\nname: api-design\ndescription: changed\ndisable-model-invocation: true\n---\n# body",
    );

    await deactivateSkills(paths);
    expect(await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8")).toContain(
      "description: changed",
    );
  });

  it("removes the Ratel marker after editing a linked Claude skill", async () => {
    await writeNativeSkill("api-design");
    await activateSkills(paths);
    await writeFile(
      join(paths.managedDir, "api-design", "SKILL.md"),
      "---\nname: api-design\ndescription: changed through Ratel\ntags: [api]\ndisable-model-invocation: true\n---\n# edited body",
    );

    await deactivateSkills(paths);

    const restored = await readFile(join(paths.nativeDir, "api-design", "SKILL.md"), "utf8");
    expect(restored).toBe(
      "---\nname: api-design\ndescription: changed through Ratel\ntags: [api]\n---\n# edited body",
    );
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

  it("deactivates a Codex-sourced linked skill without moving native files", async () => {
    await writeCodexSkill("from-codex");
    await activateSkills(paths);
    const result = await deactivateSkills(paths);
    expect(result.restored.map((m) => m.id)).toEqual(["from-codex"]);
    expect(await exists(join(paths.codexDir, "from-codex", "SKILL.md"))).toBe(true);
    expect(await exists(join(paths.nativeDir, "from-codex"))).toBe(false);
    expect(await exists(join(paths.managedDir, "from-codex"))).toBe(false);
  });

  it("restores a sourceless legacy moved manifest entry to Claude", async () => {
    await mkdir(join(paths.managedDir, "legacy"), { recursive: true });
    await writeFile(
      join(paths.managedDir, "legacy", "SKILL.md"),
      "---\nname: legacy\ndescription: d\n---\n# body",
    );
    await mkdir(join(home, ".ratel"), { recursive: true });
    await writeFile(
      paths.manifestPath,
      JSON.stringify({
        version: 1,
        managed: [{ id: "legacy", originalPath: join(paths.nativeDir, "legacy"), movedAt: "x" }],
      }),
    );

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
    await mkdir(join(paths.managedDir, "api-design"), { recursive: true });
    await writeFile(
      join(paths.managedDir, "api-design", "SKILL.md"),
      "---\nname: api-design\ndescription: d\n---\n# body",
    );
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
