import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfiguredSkills } from "./resolve.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveConfiguredSkills", () => {
  it("uses the default user legacy directory only when dirs is absent", async () => {
    const homeDir = await tempDir();
    await writeSkill(
      join(homeDir, ".ratel", "skills", "default-skill"),
      "default-skill",
      "Default skill",
      "Default body.",
    );

    const withDefault = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" } }],
    });
    const explicitlyEmpty = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" }, config: { dirs: [] } }],
    });

    expect(withDefault.effectiveSkills.map(({ id }) => id)).toEqual(["default-skill"]);
    expect(withDefault.registrations[0]?.ref.kind).toBe("legacy");
    expect(explicitlyEmpty.effectiveSkills).toEqual([]);
    expect(explicitlyEmpty.registrations).toEqual([]);
  });

  it("keeps an empty legacy directory in watch inputs so additions are observable", async () => {
    const homeDir = await tempDir();
    const legacyDir = join(homeDir, "empty-legacy");
    await mkdir(legacyDir, { recursive: true });
    const canonicalLegacyDir = await realpath(legacyDir);

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" }, config: { dirs: [legacyDir] } }],
    });

    expect(catalog.effectiveSkills).toEqual([]);
    expect(catalog.watchInputs).toContain(canonicalLegacyDir);
    expect(catalog.watchInputs).toContain(dirname(canonicalLegacyDir));
  });

  it("watches the configured path and parent when a legacy directory is missing", async () => {
    const homeDir = await tempDir();
    const ratelDir = join(homeDir, ".ratel");
    const missingDir = join(ratelDir, "missing-legacy");
    await mkdir(ratelDir, { recursive: true });

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" }, config: { dirs: ["missing-legacy"] } }],
    });

    expect(catalog.effectiveSkills).toEqual([]);
    expect(catalog.watchInputs).toContain(ratelDir);
    expect(catalog.watchInputs).toContain(missingDir);
  });

  it("lets the later configured legacy directory win an id collision", async () => {
    const homeDir = await tempDir();
    const firstDir = join(homeDir, "a-first");
    const laterDir = join(homeDir, "z-later");
    await writeSkill(join(firstDir, "shared"), "shared", "First version", "First body.");
    await writeSkill(join(laterDir, "shared"), "shared", "Later version", "Later body.");

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" }, config: { dirs: [firstDir, laterDir] } }],
    });

    expect(catalog.effectiveSkills).toEqual([
      expect.objectContaining({ id: "shared", description: "Later version" }),
    ]);
    expect(catalog.registrations.map(({ state }) => state)).toEqual(["shadowed", "effective"]);
  });

  it("uses the legacy directory name when frontmatter omits name", async () => {
    const homeDir = await tempDir();
    const legacyDir = join(homeDir, "legacy");
    const skillDir = join(legacyDir, "review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Review changes\n---\nReview body.\n",
    );

    const result = await resolveConfiguredSkills({
      homeDir,
      scopes: [{ ref: { scope: "user" }, config: { dirs: [legacyDir] } }],
    });

    expect(result.effectiveSkills.map(({ id }) => id)).toEqual(["review"]);
  });

  it("prefers an explicit registration over legacy directories in the same scope", async () => {
    const homeDir = await tempDir();
    const legacyDir = join(homeDir, "legacy");
    const explicitDir = join(homeDir, "explicit-review");
    await writeSkill(join(legacyDir, "review"), "review", "Legacy review", "Legacy body.");
    await writeSkill(explicitDir, "review", "Explicit review", "Explicit body.");

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [
        {
          ref: { scope: "user" },
          config: {
            entries: { review: { mode: "reference", path: explicitDir } },
            dirs: [legacyDir],
          },
        },
      ],
    });

    expect(catalog.effectiveSkills[0]).toEqual(
      expect.objectContaining({ id: "review", description: "Explicit review" }),
    );
    expect(catalog.registrations.map(({ state }) => state)).toEqual(["effective", "shadowed"]);
    expect(catalog.registrations[1]?.shadowedBy?.kind).toBe("entry");
  });

  it("marks registrations of the same canonical source as duplicates", async () => {
    const homeDir = await tempDir();
    const sharedDir = join(homeDir, "shared-source");
    await mkdir(sharedDir, { recursive: true });
    await writeFile(
      join(sharedDir, "SKILL.md"),
      "---\ndescription: Shared instructions\n---\nShared body.\n",
      "utf8",
    );

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [
        {
          ref: { scope: "user" },
          config: {
            entries: {
              alpha: { mode: "reference", path: sharedDir },
              beta: { mode: "reference", path: sharedDir },
            },
            dirs: [],
          },
        },
      ],
    });

    expect(catalog.effectiveSkills.map(({ id }) => id)).toEqual(["alpha"]);
    expect(catalog.registrations[1]).toEqual(
      expect.objectContaining({
        id: "beta",
        state: "duplicate",
        duplicateOf: expect.objectContaining({ id: "alpha", kind: "entry" }),
      }),
    );
  });

  it("serves an explicitly registered user reference and retains its provenance", async () => {
    const homeDir = await tempDir();
    const skillDir = join(homeDir, ".agents", "skills", "review");
    await writeSkill(skillDir, "review", "Reviews pull requests", "Review the diff.");
    const canonicalSkillDir = await realpath(skillDir);

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [
        {
          ref: { scope: "user" },
          config: {
            entries: {
              review: { mode: "reference", path: skillDir, source: "codex" },
            },
          },
        },
      ],
    });

    expect(catalog.effectiveSkills).toEqual([
      expect.objectContaining({ id: "review", description: "Reviews pull requests" }),
    ]);
    expect(catalog.registrations).toEqual([
      expect.objectContaining({
        id: "review",
        state: "effective",
        canonicalPath: canonicalSkillDir,
      }),
    ]);
    expect(catalog.diagnostics).toEqual([]);
  });

  it("uses local-project-user precedence without letting an invalid override hide a fallback", async () => {
    const homeDir = await tempDir();
    const projectRoot = join(homeDir, "repo");
    const userSkill = join(homeDir, "user-review");
    const projectSkill = join(projectRoot, ".agents", "skills", "review");
    await writeSkill(userSkill, "review", "User review", "User body.");
    await writeSkill(projectSkill, "review", "Project review", "Project body.");

    const catalog = await resolveConfiguredSkills({
      homeDir,
      projectRoot,
      scopes: [
        {
          ref: { scope: "user" },
          config: { entries: { review: { mode: "reference", path: userSkill } } },
        },
        {
          ref: { scope: "project", projectId: "project-1" },
          config: {
            entries: { review: { mode: "reference", path: ".agents/skills/review" } },
          },
        },
        {
          ref: { scope: "local", projectId: "project-1" },
          config: { entries: { review: { mode: "reference", path: "missing-review" } } },
        },
      ],
    });

    expect(catalog.effectiveSkills).toEqual([
      expect.objectContaining({
        id: "review",
        description: "Project review",
        body: "Project body.",
      }),
    ]);
    expect(catalog.registrations.map(({ scopeRef, state }) => [scopeRef.scope, state])).toEqual([
      ["user", "shadowed"],
      ["project", "effective"],
      ["local", "invalid"],
    ]);
  });

  it("rejects an absolute project reference without hiding a valid user fallback", async () => {
    const homeDir = await tempDir();
    const projectRoot = join(homeDir, "repo");
    const projectSkill = join(projectRoot, ".agents", "skills", "review");
    const userSkill = join(homeDir, "user-review");
    await writeSkill(projectSkill, "review", "Project review", "Project body.");
    await writeSkill(userSkill, "review", "User review", "User body.");

    const catalog = await resolveConfiguredSkills({
      homeDir,
      projectRoot,
      scopes: [
        {
          ref: { scope: "user" },
          config: {
            entries: { review: { mode: "reference", path: userSkill } },
            dirs: [],
          },
        },
        {
          ref: { scope: "project", projectId: "project-1" },
          config: {
            entries: { review: { mode: "reference", path: projectSkill } },
            dirs: [],
          },
        },
      ],
    });

    expect(catalog.effectiveSkills[0]).toEqual(
      expect.objectContaining({ id: "review", description: "User review" }),
    );
    expect(catalog.registrations.map(({ state }) => state)).toEqual(["effective", "invalid"]);
    expect(catalog.registrations[1]?.diagnostics[0]?.message).toMatch(/relative/i);
  });

  it("rejects traversal and symlink references whose realpaths escape the project", async () => {
    const homeDir = await tempDir();
    const projectRoot = join(homeDir, "repo");
    const prefixTrap = join(homeDir, "repo-other", "prefix");
    const symlinkTarget = join(homeDir, "outside", "linked");
    const linkedFromProject = join(projectRoot, "links", "linked");
    await writeSkill(prefixTrap, "prefix", "Prefix trap", "Outside body.");
    await writeSkill(symlinkTarget, "linked", "Symlink escape", "Outside body.");
    await mkdir(join(projectRoot, "links"), { recursive: true });
    await symlink(
      symlinkTarget,
      linkedFromProject,
      process.platform === "win32" ? "junction" : "dir",
    );

    const catalog = await resolveConfiguredSkills({
      homeDir,
      projectRoot,
      scopes: [
        {
          ref: { scope: "project", projectId: "project-1" },
          config: {
            entries: {
              prefix: { mode: "reference", path: "../repo-other/prefix" },
              linked: { mode: "reference", path: "links/linked" },
            },
            dirs: [],
          },
        },
      ],
    });

    expect(catalog.effectiveSkills).toEqual([]);
    expect(catalog.registrations.map(({ state }) => state)).toEqual(["invalid", "invalid"]);
    expect(catalog.diagnostics.map(({ message }) => message)).toEqual([
      expect.stringMatching(/outside.*project root/i),
      expect.stringMatching(/outside.*project root/i),
    ]);
  });

  it("marks a copy editable only when its ownership marker matches its id", async () => {
    const homeDir = await tempDir();
    const managedRoot = join(homeDir, ".ratel", "skills");
    const ownedDir = join(managedRoot, "owned");
    const unownedDir = join(managedRoot, "unowned");
    await writeSkill(ownedDir, "owned", "Owned copy", "Owned body.");
    await writeSkill(unownedDir, "unowned", "Unowned copy", "Unowned body.");
    await writeFile(
      join(ownedDir, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: "owned" })}\n`,
      "utf8",
    );
    await writeFile(
      join(unownedDir, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: "someone-else" })}\n`,
      "utf8",
    );

    const catalog = await resolveConfiguredSkills({
      homeDir,
      scopes: [
        {
          ref: { scope: "user" },
          config: {
            entries: {
              owned: { mode: "copy" },
              unowned: { mode: "copy" },
            },
            dirs: [],
          },
        },
      ],
    });

    expect(catalog.effectiveSkills.map(({ id }) => id)).toEqual(["owned", "unowned"]);
    expect(catalog.registrations.map(({ id, editable }) => [id, editable])).toEqual([
      ["owned", true],
      ["unowned", false],
    ]);
  });

  it("serves and fingerprints bundled resource contents and exposes their watch inputs", async () => {
    const homeDir = await tempDir();
    const skillDir = join(homeDir, "resourceful");
    const referencePath = join(skillDir, "REFERENCE.md");
    const scriptsDir = join(skillDir, "scripts");
    const scriptPath = join(scriptsDir, "scan.sh");
    await writeSkill(skillDir, "resourceful", "Uses resources", "Base body.");
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(referencePath, "Version one reference", "utf8");
    await writeFile(scriptPath, "echo scan", "utf8");
    const canonicalSkillDir = await realpath(skillDir);
    const input = {
      homeDir,
      scopes: [
        {
          ref: { scope: "user" as const },
          config: {
            entries: { resourceful: { mode: "reference" as const, path: skillDir } },
            dirs: [],
          },
        },
      ],
    };

    const before = await resolveConfiguredSkills(input);
    await writeFile(referencePath, "Version two reference", "utf8");
    const after = await resolveConfiguredSkills(input);

    expect(before.effectiveSkills[0]?.body).toContain("Version one reference");
    expect(after.effectiveSkills[0]?.body).toContain("Version two reference");
    expect(after.effectiveSkills[0]?.body).toContain("echo scan");
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(new Set(after.watchInputs)).toEqual(
      new Set([
        dirname(canonicalSkillDir),
        canonicalSkillDir,
        join(canonicalSkillDir, "SKILL.md"),
        join(canonicalSkillDir, "REFERENCE.md"),
        join(canonicalSkillDir, "scripts"),
        join(canonicalSkillDir, "scripts", "scan.sh"),
      ]),
    );
  });

  it("rejects absolute project legacy dirs and legacy skills that escape through symlinks", async () => {
    const homeDir = await tempDir();
    const projectRoot = join(homeDir, "repo");
    const absoluteLegacyDir = join(homeDir, "absolute-legacy");
    const outsideLinkedSkill = join(homeDir, "outside", "linked");
    const projectLegacyDir = join(projectRoot, "legacy");
    await writeSkill(
      join(absoluteLegacyDir, "absolute"),
      "absolute",
      "Absolute legacy",
      "Outside body.",
    );
    await writeSkill(outsideLinkedSkill, "linked", "Linked legacy", "Outside body.");
    await mkdir(projectLegacyDir, { recursive: true });
    await symlink(
      outsideLinkedSkill,
      join(projectLegacyDir, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const catalog = await resolveConfiguredSkills({
      homeDir,
      projectRoot,
      scopes: [
        {
          ref: { scope: "project", projectId: "project-1" },
          config: { dirs: [absoluteLegacyDir, "legacy"] },
        },
      ],
    });

    expect(catalog.effectiveSkills).toEqual([]);
    expect(catalog.registrations.map(({ id, state }) => [id, state])).toEqual([
      ["linked", "invalid"],
    ]);
    expect(catalog.diagnostics.map(({ message }) => message)).toEqual([
      expect.stringMatching(/legacy.*relative/i),
      expect.stringMatching(/outside.*project root/i),
    ]);
  });

  it("rejects project and local copies whose derived locations escape through .ratel", async () => {
    const homeDir = await tempDir();
    const projectRoot = join(homeDir, "repo");
    const outsideRatel = join(homeDir, "outside-ratel");
    const projectCopy = join(outsideRatel, "skills", "project-copy");
    const localCopy = join(outsideRatel, "skills.local", "local-copy");
    await writeSkill(projectCopy, "project-copy", "Project copy", "Outside body.");
    await writeSkill(localCopy, "local-copy", "Local copy", "Outside body.");
    await writeFile(
      join(projectCopy, ".ratel-skill.json"),
      JSON.stringify({ version: 1, id: "project-copy" }),
      "utf8",
    );
    await writeFile(
      join(localCopy, ".ratel-skill.json"),
      JSON.stringify({ version: 1, id: "local-copy" }),
      "utf8",
    );
    await mkdir(projectRoot, { recursive: true });
    await symlink(
      outsideRatel,
      join(projectRoot, ".ratel"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const catalog = await resolveConfiguredSkills({
      homeDir,
      projectRoot,
      scopes: [
        {
          ref: { scope: "project", projectId: "project-1" },
          config: { entries: { "project-copy": { mode: "copy" } }, dirs: [] },
        },
        {
          ref: { scope: "local", projectId: "project-1" },
          config: { entries: { "local-copy": { mode: "copy" } }, dirs: [] },
        },
      ],
    });

    expect(catalog.effectiveSkills).toEqual([]);
    expect(catalog.registrations.map(({ id, state, editable }) => [id, state, editable])).toEqual([
      ["project-copy", "invalid", false],
      ["local-copy", "invalid", false],
    ]);
    expect(catalog.diagnostics.map(({ message }) => message)).toEqual([
      expect.stringMatching(/outside.*project root/i),
      expect.stringMatching(/outside.*project root/i),
    ]);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratel-skill-resolver-"));
  cleanups.push(dir);
  return dir;
}

async function writeSkill(
  dir: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
}
