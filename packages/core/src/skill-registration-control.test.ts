import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigControlPlane } from "./config-control-plane.js";
import { createContextSnapshotResolver } from "./context-snapshot.js";
import { createMutationEngine, documentRevision } from "./mutation-engine.js";
import { createPreparedChangeCoordinator } from "./prepared-change-coordinator.js";
import { createProjectRegistry } from "./project-registry.js";
import { createSkillDiscovery } from "./skill-discovery.js";
import { createSkillRegistrationControlPlane } from "./skill-registration-control.js";

describe("SkillRegistrationControlPlane", () => {
  let root: string;
  let homeDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ratel-skill-registration-"));
    homeDir = join(root, "home");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    entries: Record<string, unknown>,
    options: { skillStorage?: boolean } = {},
  ) {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(configPath, `${JSON.stringify({ skills: { entries, dirs: [] } }, null, 2)}\n`);
    const registry = createProjectRegistry({ homeDir });
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const configControlPlane = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      preparedChanges,
    });
    const snapshotResolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
    return {
      configPath,
      registry,
      control: createSkillRegistrationControlPlane({
        homeDir,
        projectRegistry: registry,
        configControlPlane,
        snapshotResolver,
        preparedChanges,
        ...(options.skillStorage !== undefined ? { skillStorage: options.skillStorage } : {}),
      }),
    };
  }

  async function putOwnedCopy(id: string) {
    const path = join(homeDir, ".ratel", "skills", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), `---\nname: ${id}\ndescription: ${id}\n---\n\nBody\n`);
    await writeFile(join(path, ".ratel-skill.json"), `${JSON.stringify({ version: 1, id })}\n`);
    return path;
  }

  it("creates an authored skill as an owned scoped copy", async () => {
    const { control, configPath } = await fixture({}, { skillStorage: false });

    const commit = await control.create({
      target: { scope: "user" },
      id: "authored",
      description: "Authored in Ratel",
      tags: ["one", "two"],
      body: "# Instructions\n\nDo the thing.",
    });

    expect(commit.result).toEqual({
      action: "create",
      target: { scope: "user" },
      id: "authored",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: {
        entries: { authored: { mode: "copy", source: "ratel" } },
        dirs: [],
      },
    });
    const copyPath = join(homeDir, ".ratel", "skills", "authored");
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain(
      'description: "Authored in Ratel"',
    );
    expect(JSON.parse(await readFile(join(copyPath, ".ratel-skill.json"), "utf8"))).toEqual({
      version: 1,
      id: "authored",
    });
  });

  it("refuses to overwrite an unregistered skill directory", async () => {
    await putOwnedCopy("existing");
    const { control } = await fixture({});

    await expect(
      control.prepareCreate({
        target: { scope: "user" },
        id: "existing",
        description: "Do not overwrite",
        tags: [],
        body: "Body",
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "registration_exists" });
    expect(
      await readFile(join(homeDir, ".ratel", "skills", "existing", "SKILL.md"), "utf8"),
    ).toContain("Body");
  });

  it("remove-scope deletes only the registration and leaves its copy", async () => {
    const copyPath = await putOwnedCopy("demo");
    const { control, configPath } = await fixture({ demo: { mode: "copy" } });

    const plan = await control.prepareRemove({
      target: { scope: "user" },
      id: "demo",
      deleteOwnedCopy: false,
    });
    await control.commit(plan.changeId);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
  });

  async function putTakeover(id: string) {
    const copyPath = await putOwnedCopy(id);
    const nativePath = join(homeDir, ".claude", "skills", id);
    await mkdir(join(homeDir, ".claude", "skills"), { recursive: true });
    await symlink(copyPath, nativePath);
    return { copyPath, nativePath };
  }

  it("deletes a taken-over skill: registration, managed copy, and native symlink", async () => {
    const { copyPath, nativePath } = await putTakeover("taken");
    const { control, configPath } = await fixture(
      {
        taken: {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: { mode: "manual-only", source: "claude" },
        },
      },
      { skillStorage: true },
    );

    await control.remove({
      target: { scope: "user" },
      id: "taken",
      deleteOwnedCopy: true,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    await expect(lstat(copyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("remove-scope of a taken-over skill keeps the native link and the copy", async () => {
    const { copyPath, nativePath } = await putTakeover("kept");
    await writeFile(
      join(copyPath, "SKILL.md"),
      "---\nname: kept\ndescription: kept\ndisable-model-invocation: true\n---\n\nBody\n",
    );
    const { control, configPath } = await fixture(
      {
        kept: {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: { mode: "manual-only", source: "claude" },
        },
      },
      { skillStorage: true },
    );

    const commit = await control.remove({
      target: { scope: "user" },
      id: "kept",
      deleteOwnedCopy: false,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await realpath(nativePath)).toBe(await realpath(copyPath));
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    expect(
      commit.backupManifest?.entries.some(
        (entry) => entry.originalPath === join(copyPath, "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      commit.backupManifest?.entries.some((entry) =>
        entry.originalPath.startsWith(join(nativePath, "")),
      ),
    ).toBe(false);

    const discovery = createSkillDiscovery({ homeDir, skillStorage: true });
    const candidates = (await discovery.discover({ kind: "global" })).candidates.filter(
      ({ id }) => id === "kept",
    );
    expect(candidates.map(({ source }) => source)).toEqual(["ratel"]);
  });

  it("remove-scope of a taken-over skill restores a previous Claude invocation line in the copy", async () => {
    const { copyPath, nativePath } = await putTakeover("prev-claude");
    await writeFile(
      join(copyPath, "SKILL.md"),
      "---\nname: prev-claude\ndescription: prev-claude\ndisable-model-invocation: true\n---\n\nBody\n",
    );
    const { control, configPath } = await fixture(
      {
        "prev-claude": {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: {
            mode: "manual-only",
            source: "claude",
            previousLine: "disable-model-invocation: false",
          },
        },
      },
      { skillStorage: true },
    );

    await control.remove({
      target: { scope: "user" },
      id: "prev-claude",
      deleteOwnedCopy: false,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await realpath(nativePath)).toBe(await realpath(copyPath));
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: false",
    );
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation: true",
    );
  });

  it("remove-scope of a taken-over Codex skill deletes the policy file Ratel created", async () => {
    const copyPath = await putOwnedCopy("prev-codex-del");
    await mkdir(join(copyPath, "agents"), { recursive: true });
    await writeFile(
      join(copyPath, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
    );
    const nativePath = join(homeDir, ".agents", "skills", "prev-codex-del");
    await mkdir(join(homeDir, ".agents", "skills"), { recursive: true });
    await symlink(copyPath, nativePath);
    const { control, configPath } = await fixture(
      {
        "prev-codex-del": {
          mode: "copy",
          path: copyPath,
          source: "codex",
          origin: "local-managed",
          hostPolicy: {
            mode: "manual-only",
            source: "codex-current",
            createdFile: true,
            createdPolicy: true,
          },
        },
      },
      { skillStorage: true },
    );

    const commit = await control.remove({
      target: { scope: "user" },
      id: "prev-codex-del",
      deleteOwnedCopy: false,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await realpath(nativePath)).toBe(await realpath(copyPath));
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
    await expect(lstat(join(copyPath, "agents", "openai.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      commit.backupManifest?.entries.some(
        (entry) => entry.originalPath === join(copyPath, "agents", "openai.yaml"),
      ),
    ).toBe(true);
  });

  it("remove-scope of a taken-over Codex skill restores a previous allow_implicit_invocation line", async () => {
    const copyPath = await putOwnedCopy("prev-codex");
    await mkdir(join(copyPath, "agents"), { recursive: true });
    await writeFile(
      join(copyPath, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n  other: keep\n",
    );
    const nativePath = join(homeDir, ".agents", "skills", "prev-codex");
    await mkdir(join(homeDir, ".agents", "skills"), { recursive: true });
    await symlink(copyPath, nativePath);
    const { control, configPath } = await fixture(
      {
        "prev-codex": {
          mode: "copy",
          path: copyPath,
          source: "codex",
          origin: "local-managed",
          hostPolicy: {
            mode: "manual-only",
            source: "codex-current",
            previousLine: "allow_implicit_invocation: true",
          },
        },
      },
      { skillStorage: true },
    );

    await control.remove({
      target: { scope: "user" },
      id: "prev-codex",
      deleteOwnedCopy: false,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await realpath(nativePath)).toBe(await realpath(copyPath));
    const yaml = await readFile(join(copyPath, "agents", "openai.yaml"), "utf8");
    expect(yaml).toContain("allow_implicit_invocation: true");
    expect(yaml).not.toContain("allow_implicit_invocation: false");
    expect(yaml).toContain("other: keep");
  });

  it("remove-scope of a taken-over skill refuses when the copy's invocation policy changed outside Ratel", async () => {
    const { copyPath, nativePath } = await putTakeover("drifted");
    await writeFile(
      join(copyPath, "SKILL.md"),
      "---\nname: drifted\ndescription: drifted\n---\n\nBody\n",
    );
    const { control, configPath } = await fixture(
      {
        drifted: {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: { mode: "manual-only", source: "claude" },
        },
      },
      { skillStorage: true },
    );
    const beforeConfig = await readFile(configPath, "utf8");
    const beforeSkill = await readFile(join(copyPath, "SKILL.md"), "utf8");

    await expect(
      control.remove({
        target: { scope: "user" },
        id: "drifted",
        deleteOwnedCopy: false,
      }),
    ).rejects.toMatchObject({
      reason: "invalid_registration",
      message: expect.stringContaining("cannot restore native invocation policy"),
    });

    expect(await readFile(configPath, "utf8")).toBe(beforeConfig);
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toBe(beforeSkill);
    expect(await realpath(nativePath)).toBe(await realpath(copyPath));
  });

  it.each([
    ["remove", true, true],
    ["remove-scope", false, true],
    ["remove", true, false],
    ["remove-scope", false, false],
  ] as const)("%s clears a taken-over skill after the managed copy was deleted outside Ratel (deleteOwnedCopy=%s, skillStorage=%s)", async (verb, deleteOwnedCopy, skillStorage) => {
    const { copyPath, nativePath } = await putTakeover("gone");
    const previous = process.env.RATEL_FEATURE_SKILL_STORAGE;
    if (!skillStorage) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
    try {
      const { control, configPath } = await fixture(
        {
          gone: {
            mode: "copy",
            path: copyPath,
            source: "claude",
            origin: "local-managed",
            hostPolicy: { mode: "manual-only", source: "claude" },
          },
        },
        skillStorage ? { skillStorage: true } : {},
      );
      await rm(copyPath, { recursive: true, force: true });

      const commit = await control.remove({
        target: { scope: "user" },
        id: "gone",
        deleteOwnedCopy,
      });

      expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
        skills: { entries: {}, dirs: [] },
      });
      expect((await lstat(nativePath)).isSymbolicLink()).toBe(true);
      expect(commit.result.brokenNativeLink).toEqual({
        path: nativePath,
        kind: "unresolved",
        copyKept: false,
      });
      expect(verb === "remove" || verb === "remove-scope").toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      else process.env.RATEL_FEATURE_SKILL_STORAGE = previous;
    }
  });

  it.each([
    true,
    false,
  ] as const)("removes a taken-over skill whose native symlink points at a missing path (deleteOwnedCopy=%s)", async (deleteOwnedCopy) => {
    const { copyPath, nativePath } = await putTakeover("orphan-link");
    await rm(nativePath, { force: true });
    await symlink(join(homeDir, ".ratel", "skills", "does-not-exist"), nativePath);
    const { control, configPath } = await fixture(
      {
        "orphan-link": {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: { mode: "manual-only", source: "claude" },
        },
      },
      { skillStorage: true },
    );

    const commit = await control.remove({
      target: { scope: "user" },
      id: "orphan-link",
      deleteOwnedCopy,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect((await lstat(nativePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
    expect(commit.result.brokenNativeLink).toEqual({
      path: nativePath,
      kind: "unresolved",
      copyKept: true,
    });
  });

  it("reports a symlink that still resolves when the managed copy is gone", async () => {
    const { copyPath, nativePath } = await putTakeover("elsewhere");
    const other = join(homeDir, "other-skill");
    await mkdir(other, { recursive: true });
    await writeFile(join(other, "SKILL.md"), "other\n");
    await rm(nativePath, { force: true });
    await symlink(other, nativePath);
    await rm(copyPath, { recursive: true, force: true });
    const { control, configPath } = await fixture(
      {
        elsewhere: {
          mode: "copy",
          path: copyPath,
          source: "claude",
          origin: "local-managed",
          hostPolicy: { mode: "manual-only", source: "claude" },
        },
      },
      { skillStorage: true },
    );

    const commit = await control.remove({
      target: { scope: "user" },
      id: "elsewhere",
      deleteOwnedCopy: true,
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect((await lstat(nativePath)).isSymbolicLink()).toBe(true);
    expect(commit.result.brokenNativeLink).toEqual({
      path: nativePath,
      kind: "copy-missing",
      copyKept: false,
    });
  });

  it("flag-off remove still deletes an ordinary copy and invents no symlink", async () => {
    const copyPath = await putOwnedCopy("plain");
    const nativePath = join(homeDir, ".claude", "skills", "plain");
    const { control } = await fixture({ plain: { mode: "copy" } }, { skillStorage: false });

    await control.remove({
      target: { scope: "user" },
      id: "plain",
      deleteOwnedCopy: true,
    });

    await expect(lstat(copyPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(nativePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("flag-off remove-scope leaves a non-symlinked native directory alone", async () => {
    const copyPath = await putOwnedCopy("still-there");
    const nativePath = join(homeDir, ".claude", "skills", "still-there");
    await mkdir(nativePath, { recursive: true });
    await writeFile(join(nativePath, "SKILL.md"), "native body\n");
    const { control } = await fixture(
      {
        "still-there": { mode: "copy" },
      },
      { skillStorage: false },
    );

    await control.remove({
      target: { scope: "user" },
      id: "still-there",
      deleteOwnedCopy: false,
    });

    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
    expect((await lstat(nativePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(join(nativePath, "SKILL.md"), "utf8")).toBe("native body\n");
  });

  it("restores the native host policy when removing a global registration", async () => {
    const source = join(homeDir, ".claude", "skills", "native");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: native\ndescription: Native\n" + "disable-model-invocation: true\n---\n\nBody\n",
    );
    const { control, configPath } = await fixture({
      native: {
        mode: "reference",
        path: source,
        source: "claude",
        hostPolicy: { mode: "manual-only", source: "claude" },
      },
    });

    await control.remove({
      target: { scope: "user" },
      id: "native",
      deleteOwnedCopy: false,
    });

    expect(await readFile(join(source, "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
  });

  it("edits an owned copy transactionally while preserving unknown frontmatter", async () => {
    const copyPath = await putOwnedCopy("demo");
    const skillPath = join(copyPath, "SKILL.md");
    const original =
      "---\nname: demo\n# keep this\ndescription: old\nlicense: MIT\ntriggers: [old]\n---\n\nOld body\n";
    await writeFile(skillPath, original);
    const { control } = await fixture({ demo: { mode: "copy" } });

    await control.edit({
      target: { scope: "user" },
      id: "demo",
      description: "new description",
      tags: ["one", "two"],
      body: "# New body",
      expectedRevision: documentRevision(original),
    });

    const updated = await readFile(skillPath, "utf8");
    expect(updated).toContain("# keep this");
    expect(updated).toContain("license: MIT");
    expect(updated).toContain('description: "new description"');
    expect(updated).toContain('tags: ["one", "two"]');
    expect(updated).not.toContain("triggers:");
    expect(updated).toContain("# New body");
  });

  it("rejects edits to references and stale owned-copy revisions", async () => {
    const reference = await fixture({
      demo: { mode: "reference", path: "/external/demo" },
    });
    await expect(
      reference.control.prepareEdit({
        target: { scope: "user" },
        id: "demo",
        description: "new",
        tags: [],
        body: "body",
      }),
    ).rejects.toMatchObject({ statusCode: 422, reason: "registration_not_editable" });

    await putOwnedCopy("owned");
    const owned = await fixture({ owned: { mode: "copy" } });
    await expect(
      owned.control.prepareEdit({
        target: { scope: "user" },
        id: "owned",
        description: "new",
        tags: [],
        body: "body",
        expectedRevision: documentRevision("stale"),
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "revision_conflict" });
  });

  it("adds a scope from an effective registration without rediscovery", async () => {
    const projectA = join(root, "scope-a");
    const projectB = join(root, "scope-b");
    const source = join(projectA, ".agents", "skills", "demo");
    await mkdir(source, { recursive: true });
    await mkdir(join(projectA, ".ratel"), { recursive: true });
    await mkdir(projectB, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n\nBody\n");
    await writeFile(
      join(projectA, ".ratel", "config.json"),
      `${JSON.stringify({
        skills: {
          entries: {
            demo: { mode: "reference", path: ".agents/skills/demo", source: "codex" },
          },
          dirs: [],
        },
      })}\n`,
    );
    const registry = createProjectRegistry({ homeDir });
    const registeredA = await registry.registerRoot(projectA);
    const registeredB = await registry.registerRoot(projectB);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const control = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: await createConfigControlPlane({
        homeDir,
        projectRegistry: registry,
        preparedChanges,
      }),
      snapshotResolver: createContextSnapshotResolver({ homeDir, projectRegistry: registry }),
      preparedChanges,
    });

    await control.addScope({
      context: { kind: "project", projectId: registeredA.id },
      target: { scope: "project", projectId: registeredB.id },
      id: "demo",
      mode: "copy",
    });

    expect(
      JSON.parse(await readFile(join(projectB, ".ratel", "config.json"), "utf8")),
    ).toMatchObject({
      skills: { entries: { demo: { mode: "copy", source: "codex" } } },
    });
    expect(
      JSON.parse(
        await readFile(join(projectB, ".ratel", "skills", "demo", ".ratel-skill.json"), "utf8"),
      ),
    ).toEqual({ version: 1, id: "demo" });
  });

  it("remove deletes an owned copy in the same recoverable transaction", async () => {
    const copyPath = await putOwnedCopy("demo");
    const { control, configPath } = await fixture({ demo: { mode: "copy" } });

    const plan = await control.prepareRemove({
      target: { scope: "user" },
      id: "demo",
      deleteOwnedCopy: true,
    });
    await control.commit(plan.changeId);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    await expect(readFile(join(copyPath, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never derives an owned-copy deletion path from a traversal registration id", async () => {
    const traversalId = "../../victim";
    const victim = join(homeDir, "victim");
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "payload.txt"), "keep me\n");
    await writeFile(
      join(victim, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: traversalId })}\n`,
    );
    const { control } = await fixture({ [traversalId]: { mode: "copy" } });

    await expect(
      control.prepareRemove({
        target: { scope: "user" },
        id: traversalId,
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(readFile(join(victim, "payload.txt"), "utf8")).resolves.toBe("keep me\n");
  });

  it("refuses forged ownership and reverse-referenced copies", async () => {
    const copyPath = await putOwnedCopy("demo");
    await writeFile(join(copyPath, ".ratel-skill.json"), '{"version":1,"id":"other"}\n');
    const forged = await fixture({ demo: { mode: "copy" } });
    await expect(
      forged.control.prepareRemove({
        target: { scope: "user" },
        id: "demo",
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 422, reason: "copy_not_owned" });

    const externalMarker = join(root, "external-marker.json");
    await writeFile(externalMarker, '{"version":1,"id":"demo"}\n');
    await rm(join(copyPath, ".ratel-skill.json"));
    await symlink(externalMarker, join(copyPath, ".ratel-skill.json"));
    await expect(
      forged.control.prepareRemove({
        target: { scope: "user" },
        id: "demo",
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 422, reason: "copy_not_owned" });

    const projectRoot = join(root, "project");
    const projectCopy = join(projectRoot, ".ratel", "skills", "demo");
    await mkdir(projectCopy, { recursive: true });
    await writeFile(
      join(projectCopy, "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n\nBody\n",
    );
    await writeFile(join(projectCopy, ".ratel-skill.json"), '{"version":1,"id":"demo"}\n');
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      `${JSON.stringify({
        skills: {
          entries: { demo: { mode: "reference", path: projectCopy } },
          dirs: [],
        },
      })}\n`,
    );
    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      `${JSON.stringify({ skills: { entries: { demo: { mode: "copy" } }, dirs: [] } })}\n`,
    );
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const referenced = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: await createConfigControlPlane({
        homeDir,
        projectRegistry: registry,
        preparedChanges,
      }),
      snapshotResolver: createContextSnapshotResolver({
        homeDir,
        projectRegistry: registry,
      }),
      preparedChanges,
    });
    await expect(
      referenced.prepareRemove({
        target: { scope: "project", projectId: project.id },
        id: "demo",
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "copy_still_referenced" });
    await expect(
      referenced.prepareEdit({
        target: { scope: "project", projectId: project.id },
        id: "demo",
        description: "changed",
        tags: [],
        body: "Changed body",
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "copy_still_referenced" });
  });

  it("rechecks reverse references under the mutation lock before deleting a copy", async () => {
    const projectRoot = join(root, "late-reference-project");
    const copyPath = join(projectRoot, ".ratel", "skills", "demo");
    await mkdir(copyPath, { recursive: true });
    await writeFile(
      join(copyPath, "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n\nBody\n",
    );
    await writeFile(join(copyPath, ".ratel-skill.json"), '{"version":1,"id":"demo"}\n');
    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      '{"skills":{"entries":{"demo":{"mode":"copy"}},"dirs":[]}}\n',
    );
    const { control, registry, configPath } = await fixture({});
    const project = await registry.registerRoot(projectRoot);
    const plan = await control.prepareRemove({
      target: { scope: "project", projectId: project.id },
      id: "demo",
      deleteOwnedCopy: true,
    });
    await writeFile(
      configPath,
      `${JSON.stringify({
        skills: {
          entries: { demo: { mode: "reference", path: copyPath } },
          dirs: [],
        },
      })}\n`,
    );

    await expect(control.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 409,
      reason: "copy_still_referenced",
    });
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
  });

  it("rechecks reverse references under the mutation lock before editing a copy", async () => {
    const projectRoot = join(root, "late-edit-reference");
    const copyPath = join(projectRoot, ".ratel", "skills", "demo");
    await mkdir(copyPath, { recursive: true });
    await writeFile(
      join(copyPath, "SKILL.md"),
      "---\nname: demo\ndescription: demo\n---\n\nBody\n",
    );
    await writeFile(join(copyPath, ".ratel-skill.json"), '{"version":1,"id":"demo"}\n');
    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      '{"skills":{"entries":{"demo":{"mode":"copy"}},"dirs":[]}}\n',
    );
    const { control, registry, configPath } = await fixture({});
    const project = await registry.registerRoot(projectRoot);
    const plan = await control.prepareEdit({
      target: { scope: "project", projectId: project.id },
      id: "demo",
      description: "changed",
      tags: [],
      body: "Changed body",
    });
    await writeFile(
      configPath,
      `${JSON.stringify({
        skills: { entries: { demo: { mode: "reference", path: copyPath } }, dirs: [] },
      })}\n`,
    );

    await expect(control.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 409,
      reason: "copy_still_referenced",
    });
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
  });

  it("persists origin and path when skillStorage is true", async () => {
    const { control, configPath } = await fixture({}, { skillStorage: true });

    await control.create({
      target: { scope: "user" },
      id: "authored",
      description: "Authored in Ratel",
      tags: [],
      body: "Body",
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: {
        entries: {
          authored: {
            mode: "copy",
            origin: "local-managed",
            path: join(homeDir, ".ratel", "skills", "authored"),
            source: "ratel",
          },
        },
        dirs: [],
      },
    });
  });

  it("refuses to delete a user copy whose path escapes ~/.ratel", async () => {
    const outside = join(root, "Documents", "escaped");
    await mkdir(outside, { recursive: true });
    await writeFile(
      join(outside, "SKILL.md"),
      "---\nname: escaped\ndescription: escaped\n---\n\nBody\n",
    );
    await writeFile(
      join(outside, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: "escaped" })}\n`,
    );
    const { control } = await fixture(
      {
        escaped: {
          mode: "copy",
          origin: "local-managed",
          path: outside,
          source: "ratel",
        },
      },
      { skillStorage: true },
    );

    await expect(
      control.prepareRemove({
        target: { scope: "user" },
        id: "escaped",
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      reason: "invalid_registration",
      name: "SkillRegistrationValidationError",
    });
    expect(await readFile(join(outside, "SKILL.md"), "utf8")).toContain("Body");
  });

  it("deletes the persisted copy path, not a re-derived sibling", async () => {
    const derived = join(homeDir, ".ratel", "skills", "relocated");
    const persisted = join(homeDir, ".ratel", "skills-alt", "relocated");
    await mkdir(derived, { recursive: true });
    await writeFile(join(derived, "SKILL.md"), "derived\n");
    await mkdir(persisted, { recursive: true });
    await writeFile(
      join(persisted, "SKILL.md"),
      "---\nname: relocated\ndescription: relocated\n---\n\nBody\n",
    );
    await writeFile(
      join(persisted, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: "relocated" })}\n`,
    );
    const { control } = await fixture(
      {
        relocated: {
          mode: "copy",
          origin: "local-managed",
          path: persisted,
          source: "ratel",
        },
      },
      { skillStorage: true },
    );

    await control.remove({
      target: { scope: "user" },
      id: "relocated",
      deleteOwnedCopy: true,
    });

    expect(await readFile(join(derived, "SKILL.md"), "utf8")).toBe("derived\n");
    await expect(readFile(join(persisted, "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("edits SKILL.md under the persisted path, not a re-derived sibling", async () => {
    const derived = join(homeDir, ".ratel", "skills", "relocated");
    const persisted = join(homeDir, ".ratel", "skills-alt", "relocated");
    await mkdir(derived, { recursive: true });
    await writeFile(join(derived, "SKILL.md"), "derived\n");
    await mkdir(persisted, { recursive: true });
    const original = "---\nname: relocated\ndescription: old\n---\n\nBody\n";
    await writeFile(join(persisted, "SKILL.md"), original);
    await writeFile(
      join(persisted, ".ratel-skill.json"),
      `${JSON.stringify({ version: 1, id: "relocated" })}\n`,
    );
    const { control } = await fixture(
      {
        relocated: {
          mode: "copy",
          origin: "local-managed",
          path: persisted,
          source: "ratel",
        },
      },
      { skillStorage: true },
    );

    await control.edit({
      target: { scope: "user" },
      id: "relocated",
      description: "new description",
      tags: [],
      body: "Updated body",
      expectedRevision: documentRevision(original),
    });

    expect(await readFile(join(derived, "SKILL.md"), "utf8")).toBe("derived\n");
    const updated = await readFile(join(persisted, "SKILL.md"), "utf8");
    expect(updated).toContain('description: "new description"');
    expect(updated).toContain("Updated body");
  });

  it("persists relative path when add-scope copies into project scope with skillStorage", async () => {
    const projectA = join(root, "scope-a");
    const projectB = join(root, "scope-b");
    const source = join(projectA, ".agents", "skills", "demo");
    await mkdir(source, { recursive: true });
    await mkdir(join(projectA, ".ratel"), { recursive: true });
    await mkdir(projectB, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: demo\n---\n\nBody\n");
    await writeFile(
      join(projectA, ".ratel", "config.json"),
      `${JSON.stringify({
        skills: {
          entries: {
            demo: { mode: "reference", path: ".agents/skills/demo", source: "codex" },
          },
          dirs: [],
        },
      })}\n`,
    );
    const registry = createProjectRegistry({ homeDir });
    const registeredA = await registry.registerRoot(projectA);
    const registeredB = await registry.registerRoot(projectB);
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
    const control = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: await createConfigControlPlane({
        homeDir,
        projectRegistry: registry,
        preparedChanges,
      }),
      snapshotResolver: createContextSnapshotResolver({ homeDir, projectRegistry: registry }),
      preparedChanges,
      skillStorage: true,
    });

    await control.addScope({
      context: { kind: "project", projectId: registeredA.id },
      target: { scope: "project", projectId: registeredB.id },
      id: "demo",
      mode: "copy",
    });

    expect(
      JSON.parse(await readFile(join(projectB, ".ratel", "config.json"), "utf8")),
    ).toMatchObject({
      skills: {
        entries: {
          demo: {
            mode: "copy",
            origin: "local-managed",
            path: ".ratel/skills/demo",
            source: "codex",
          },
        },
      },
    });
  });

  it("does not rewrite config bytes on snapshot resolve", async () => {
    const original = `${JSON.stringify(
      {
        skills: {
          entries: { demo: { mode: "copy", source: "ratel" } },
          dirs: [],
        },
      },
      null,
      2,
    )}\n`;
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(configPath, original);
    await putOwnedCopy("demo");
    const registry = createProjectRegistry({ homeDir });
    const resolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
    await resolver.resolve({ kind: "global" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });

  it("snapshots when skillStorage is true even if the env flag is unset", async () => {
    const previous = process.env.RATEL_FEATURE_SKILL_STORAGE;
    delete process.env.RATEL_FEATURE_SKILL_STORAGE;
    try {
      const { control } = await fixture({}, { skillStorage: true });
      const commit = await control.create({
        target: { scope: "user" },
        id: "authored",
        description: "Authored in Ratel",
        tags: [],
        body: "Body",
      });
      expect(commit.backupManifest).not.toBeNull();
      expect(commit.backupManifest?.entries.some((entry) => entry.kind !== undefined)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      else process.env.RATEL_FEATURE_SKILL_STORAGE = previous;
    }
  });

  it("keeps per-file backups when skillStorage is false even if the env flag is on", async () => {
    const previous = process.env.RATEL_FEATURE_SKILL_STORAGE;
    process.env.RATEL_FEATURE_SKILL_STORAGE = "1";
    try {
      const { control } = await fixture({}, { skillStorage: false });
      const commit = await control.create({
        target: { scope: "user" },
        id: "authored",
        description: "Authored in Ratel",
        tags: [],
        body: "Body",
      });
      expect(commit.backupManifest).not.toBeNull();
      expect(commit.backupManifest?.entries.every((entry) => entry.kind === undefined)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      else process.env.RATEL_FEATURE_SKILL_STORAGE = previous;
    }
  });
});
