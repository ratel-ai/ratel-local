import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigControlPlane } from "./config-control-plane.js";
import { createContextSnapshotResolver } from "./context-snapshot.js";
import { createMutationEngine, documentRevision } from "./mutation-engine.js";
import { createProjectRegistry } from "./project-registry.js";
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

  async function fixture(entries: Record<string, unknown>) {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(configPath, `${JSON.stringify({ skills: { entries, dirs: [] } }, null, 2)}\n`);
    const registry = createProjectRegistry({ homeDir });
    const mutationEngine = await createMutationEngine({ controlDir: join(homeDir, ".ratel") });
    const configControlPlane = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      mutationEngine,
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
        mutationEngine,
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

  it("remove-scope deletes only the registration and leaves its copy", async () => {
    const copyPath = await putOwnedCopy("demo");
    const { control, configPath } = await fixture({ demo: { mode: "copy" } });

    const plan = await control.previewRemove({
      target: { scope: "user" },
      id: "demo",
      deleteOwnedCopy: false,
    });
    await control.apply(plan, { digest: plan.digest });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      skills: { entries: {}, dirs: [] },
    });
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
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
      reference.control.previewEdit({
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
      owned.control.previewEdit({
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
    const control = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: await createConfigControlPlane({
        homeDir,
        projectRegistry: registry,
        mutationEngine,
      }),
      snapshotResolver: createContextSnapshotResolver({ homeDir, projectRegistry: registry }),
      mutationEngine,
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

    const plan = await control.previewRemove({
      target: { scope: "user" },
      id: "demo",
      deleteOwnedCopy: true,
    });
    await control.apply(JSON.parse(JSON.stringify(plan)), { digest: plan.digest });

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
      control.previewRemove({
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
      forged.control.previewRemove({
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
      forged.control.previewRemove({
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
    const referenced = createSkillRegistrationControlPlane({
      homeDir,
      projectRegistry: registry,
      configControlPlane: await createConfigControlPlane({
        homeDir,
        projectRegistry: registry,
        mutationEngine,
      }),
      snapshotResolver: createContextSnapshotResolver({
        homeDir,
        projectRegistry: registry,
      }),
      mutationEngine,
    });
    await expect(
      referenced.previewRemove({
        target: { scope: "project", projectId: project.id },
        id: "demo",
        deleteOwnedCopy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "copy_still_referenced" });
    await expect(
      referenced.previewEdit({
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
    const plan = await control.previewRemove({
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

    await expect(control.apply(plan, { digest: plan.digest })).rejects.toMatchObject({
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
    const plan = await control.previewEdit({
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

    await expect(control.apply(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      reason: "copy_still_referenced",
    });
    expect(await readFile(join(copyPath, "SKILL.md"), "utf8")).toContain("Body");
  });
});
