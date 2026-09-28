import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId, RatelScopeRef } from "./context.js";
import { createMutationEngine } from "./mutation-engine.js";
import { createPreparedChangeCoordinator } from "./prepared-change-coordinator.js";
import { createProjectRegistry } from "./project-registry.js";
import { createSkillDiscovery } from "./skill-discovery.js";
import {
  createSkillImportControlPlane,
  type SkillImportConflictError,
  SkillImportValidationError,
} from "./skill-import.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function putSkill(path: string, id: string, body = "Instructions") {
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}`,
  );
}

async function fixture(options: { skillStorage?: boolean } = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), "ratel-skill-import-home-"));
  const projectA = await mkdtemp(join(tmpdir(), "ratel-skill-import-a-"));
  const projectB = await mkdtemp(join(tmpdir(), "ratel-skill-import-b-"));
  roots.push(homeDir, projectA, projectB);

  const projectRegistry = createProjectRegistry({ homeDir });
  const registeredA = await projectRegistry.registerRoot(projectA, "A");
  const registeredB = await projectRegistry.registerRoot(projectB, "B");
  const discovery = createSkillDiscovery({
    homeDir,
    ...(options.skillStorage !== undefined ? { skillStorage: options.skillStorage } : {}),
  });
  const mutationEngine = await createMutationEngine({
    controlDir: join(homeDir, ".ratel"),
  });
  const preparedChanges = createPreparedChangeCoordinator({ mutationEngine });
  const controlPlane = createSkillImportControlPlane({
    homeDir,
    projectRegistry,
    discovery,
    preparedChanges,
    ...(options.skillStorage !== undefined ? { skillStorage: options.skillStorage } : {}),
  });

  return {
    homeDir,
    projectA,
    projectB,
    projectRegistry,
    projectAId: registeredA.id,
    projectBId: registeredB.id,
    discovery,
    controlPlane,
  };
}

function projectScope(projectId: ProjectId): RatelScopeRef {
  return { scope: "project", projectId };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("SkillImportControlPlane", () => {
  it("keeps the first harness copy and skips duplicate skill ids in one import", async () => {
    const f = await fixture();
    await putSkill(join(f.homeDir, ".claude", "skills", "shared"), "shared", "Claude body");
    await putSkill(join(f.homeDir, ".agents", "skills", "shared"), "shared", "Codex body");
    const candidates = (await f.discovery.discover({ kind: "global" })).candidates.filter(
      ({ id }) => id === "shared",
    );
    expect(candidates.map(({ source }) => source)).toEqual(["claude", "codex-current"]);

    const selections = candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      targets: [{ scopeRef: { scope: "user" as const }, mode: "reference" as const }],
    }));
    await expect(f.controlPlane.prepare(selections)).rejects.toBeInstanceOf(
      SkillImportValidationError,
    );

    const plan = await f.controlPlane.prepare(selections, { duplicateStrategy: "keep-first" });

    expect(plan.preview.skippedDuplicates).toEqual([
      {
        candidateId: candidates[1]?.candidateId,
        id: "shared",
        keptCandidateId: candidates[0]?.candidateId,
        target: { scopeRef: { scope: "user" }, mode: "reference" },
      },
    ]);

    const commit = await f.controlPlane.commit(plan.changeId);

    expect(commit.result.imported).toEqual([
      {
        candidateId: candidates[0]?.candidateId,
        id: "shared",
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    expect(commit.result.skippedDuplicates).toEqual(plan.preview.skippedDuplicates);
    expect(await readJson(join(f.homeDir, ".ratel", "config.json"))).toMatchObject({
      skills: {
        entries: {
          shared: {
            mode: "reference",
            path: candidates[0]?.canonicalPath,
            source: "claude",
          },
        },
      },
    });
  });

  it("imports one project candidate by reference in A and copy in B in one transaction", async () => {
    const f = await fixture();
    const source = join(f.projectA, ".agents", "skills", "demo");
    await putSkill(source, "demo");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [
          { scopeRef: projectScope(f.projectAId), mode: "reference" },
          { scopeRef: projectScope(f.projectBId), mode: "copy" },
        ],
      },
    ]);

    expect(plan.preview.files.map(({ kind }) => kind).sort()).toEqual([
      "directory",
      "file",
      "file",
    ]);

    const commit = await f.controlPlane.commit(plan.changeId);

    expect(commit.result.imported).toEqual([
      {
        candidateId: candidate.candidateId,
        id: "demo",
        targets: [
          { scopeRef: projectScope(f.projectAId), mode: "reference" },
          { scopeRef: projectScope(f.projectBId), mode: "copy" },
        ],
      },
    ]);

    const configA = await readJson(join(f.projectA, ".ratel", "config.json"));
    const configB = await readJson(join(f.projectB, ".ratel", "config.json"));
    expect(configA).toMatchObject({
      skills: {
        entries: {
          demo: {
            mode: "reference",
            path: ".agents/skills/demo",
            source: "codex",
          },
        },
      },
    });
    expect(configB).toMatchObject({
      skills: {
        entries: {
          demo: {
            mode: "copy",
            source: "codex",
            copiedFrom: { source: "codex-current", id: "demo" },
          },
        },
      },
    });
    expect(
      await readJson(join(f.projectB, ".ratel", "skills", "demo", ".ratel-skill.json")),
    ).toEqual({ version: 1, id: "demo" });
    expect(
      await readFile(join(f.projectB, ".ratel", "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("demo skill");
    expect(await readFile(join(source, "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    await expect(readFile(join(source, "agents", "openai.yaml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("adopts a real legacy Ratel directory as an owned copy during preview/apply", async () => {
    const f = await fixture();
    const source = join(f.homeDir, ".ratel", "skills", "legacy");
    await putSkill(source, "legacy");
    await writeFile(join(source, "resource.txt"), "preserved\n");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id, source: kind }) => id === "legacy" && kind === "ratel",
    );
    if (!candidate) throw new Error("legacy candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);

    expect(plan.preview.files.map(({ kind }) => kind)).toEqual(["file", "file"]);
    await f.controlPlane.commit(plan.changeId);
    expect(await readJson(join(source, ".ratel-skill.json"))).toEqual({
      version: 1,
      id: "legacy",
    });
    await expect(readFile(join(source, "resource.txt"), "utf8")).resolves.toBe("preserved\n");
    expect(await readJson(join(f.homeDir, ".ratel", "config.json"))).toMatchObject({
      skills: { entries: { legacy: { mode: "copy" } } },
    });
  });

  it("returns a typed 409 when a candidate becomes stale after preview", async () => {
    const f = await fixture();
    const source = join(f.homeDir, ".agents", "skills", "stale");
    await putSkill(source, "stale", "before");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "stale",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);
    await putSkill(source, "stale", "after");

    await expect(f.controlPlane.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 409,
      reason: "revision_conflict",
    } satisfies Partial<SkillImportConflictError>);
  });

  it("rejects a client-modified or replayed import preview", async () => {
    const f = await fixture();
    await putSkill(join(f.homeDir, ".agents", "skills", "secure"), "secure");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "secure",
    );
    if (!candidate) throw new Error("candidate not discovered");
    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    plan.preview.files.length = 0;
    await f.controlPlane.commit(plan.changeId);
    await expect(f.controlPlane.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PREPARED_CHANGE_UNAVAILABLE",
    });
  });

  it("rejects a reference from project A into project B", async () => {
    const f = await fixture();
    await putSkill(join(f.projectA, ".claude", "skills", "local-only"), "local-only");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];

    await expect(
      f.controlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: projectScope(f.projectBId), mode: "reference" }],
        },
      ]),
    ).rejects.toBeInstanceOf(SkillImportValidationError);
  });

  it("preserves unknown document and skills fields plus existing registrations", async () => {
    const f = await fixture({ skillStorage: false });
    await putSkill(join(f.homeDir, ".claude", "skills", "new-skill"), "new-skill");
    const userConfigPath = join(f.homeDir, ".ratel", "config.json");
    await mkdir(join(f.homeDir, ".ratel"), { recursive: true });
    await writeFile(
      userConfigPath,
      `${JSON.stringify(
        {
          futureTopLevel: { keep: true },
          mcpServers: { demo: { type: "stdio", command: "demo" } },
          skills: {
            futureSkillsField: { keep: true },
            dirs: [],
            entries: {
              existing: { mode: "reference", path: "/opt/existing", source: "unknown" },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "new-skill",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    expect(await readJson(userConfigPath)).toEqual({
      futureTopLevel: { keep: true },
      mcpServers: { demo: { type: "stdio", command: "demo" } },
      skills: {
        futureSkillsField: { keep: true },
        dirs: [],
        entries: {
          existing: { mode: "reference", path: "/opt/existing", source: "unknown" },
          "new-skill": {
            mode: "reference",
            path: candidate.canonicalPath,
            source: "claude",
            hostPolicy: {
              mode: "manual-only",
              source: "claude",
            },
          },
        },
      },
    });
    expect(
      await readFile(join(f.homeDir, ".claude", "skills", "new-skill", "SKILL.md"), "utf8"),
    ).toContain("disable-model-invocation: true");
  });

  it("makes a global Codex skill manual-only without creating a Ratel symlink", async () => {
    const f = await fixture();
    const source = join(f.homeDir, ".agents", "skills", "codex-skill");
    await putSkill(source, "codex-skill");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "codex-skill",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    expect(await readFile(join(source, "agents", "openai.yaml"), "utf8")).toContain(
      "allow_implicit_invocation: false",
    );
    await expect(
      readFile(join(f.homeDir, ".ratel", "skills", "codex-skill", "SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readJson(join(f.homeDir, ".ratel", "config.json"))).toMatchObject({
      skills: {
        entries: {
          "codex-skill": {
            mode: "reference",
            source: "codex",
            hostPolicy: {
              mode: "manual-only",
              source: "codex-current",
              createdFile: true,
              createdPolicy: true,
            },
          },
        },
      },
    });
  });

  it("takes over a global Claude skill: managed copy, symlinked original, policy in the copy", async () => {
    const f = await fixture({ skillStorage: true });
    const original = join(f.homeDir, ".claude", "skills", "taken");
    await putSkill(original, "taken");
    await writeFile(join(original, "reference.md"), "extra");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "taken",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);
    const commit = await f.controlPlane.commit(plan.changeId);

    const copy = join(f.homeDir, ".ratel", "skills", "taken");
    expect((await lstat(original)).isSymbolicLink()).toBe(true);
    expect(await readlink(original)).toBe(copy);
    expect(await readFile(join(copy, "reference.md"), "utf8")).toBe("extra");
    // The host reads the policy through the link; the copy carries it.
    expect(await readFile(join(copy, "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
    expect(await readFile(join(original, "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
    expect(await readJson(join(f.homeDir, ".ratel", "config.json"))).toMatchObject({
      skills: {
        entries: {
          taken: {
            mode: "copy",
            origin: "local-managed",
            path: copy,
            source: "claude",
            copiedFrom: { source: "claude", id: candidate.candidateId ? "taken" : "taken" },
            hostPolicy: { mode: "manual-only", source: "claude" },
          },
        },
      },
    });

    // The snapshot holds the original directory, symlink-free.
    const captured = commit.backupManifest?.entries.filter((entry) =>
      entry.originalPath.startsWith(original),
    );
    expect(captured?.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["dir", "file", "file"]),
    );
    const capturedSkill = captured?.find(({ originalPath }) =>
      originalPath.endsWith(join("taken", "SKILL.md")),
    );
    if (!capturedSkill) throw new Error("SKILL.md not captured");
    expect(await readFile(capturedSkill.backupPath, "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  it("lists a taken-over skill once and refuses a second import", async () => {
    const f = await fixture({ skillStorage: true });
    const original = join(f.homeDir, ".claude", "skills", "taken");
    await putSkill(original, "taken");
    const first = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "taken",
    );
    if (!first) throw new Error("candidate not discovered");
    const plan = await f.controlPlane.prepare([
      {
        candidateId: first.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    const rediscovered = (await f.discovery.discover({ kind: "global" })).candidates.filter(
      ({ id }) => id === "taken",
    );
    expect(rediscovered.map(({ source }) => source)).toEqual(["ratel"]);

    const again = rediscovered[0];
    if (!again) throw new Error("managed copy not discovered");
    await expect(
      f.controlPlane.prepare([
        {
          candidateId: again.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
        },
      ]),
    ).rejects.toBeInstanceOf(SkillImportValidationError);
    expect((await lstat(original)).isSymbolicLink()).toBe(true);
    expect(await realpath(original)).toBe(
      await realpath(join(f.homeDir, ".ratel", "skills", "taken")),
    );
  });

  it("changes nothing on disk when the tree cannot be copied", async () => {
    const f = await fixture({ skillStorage: true });
    const original = join(f.homeDir, ".claude", "skills", "linky");
    await putSkill(original, "linky");
    await symlink(join(f.homeDir, ".claude"), join(original, "escape"));
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "linky",
    );
    if (!candidate) throw new Error("candidate not discovered");

    await expect(
      f.controlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
        },
      ]),
    ).rejects.toThrow(/symlink/);

    expect((await lstat(original)).isDirectory()).toBe(true);
    await expect(lstat(join(f.homeDir, ".ratel", "skills", "linky"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(f.homeDir, ".ratel", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to take over a native path that is itself a link", async () => {
    const f = await fixture({ skillStorage: true });
    const elsewhere = join(f.homeDir, "dotfiles", "linked");
    await putSkill(elsewhere, "linked");
    await mkdir(join(f.homeDir, ".claude", "skills"), { recursive: true });
    await symlink(elsewhere, join(f.homeDir, ".claude", "skills", "linked"));
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "linked",
    );
    if (!candidate) throw new Error("candidate not discovered");

    await expect(
      f.controlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
        },
      ]),
    ).rejects.toThrow(/import it as a reference/);
  });

  it("rejects when a target config changes between derivation and mutation preview", async () => {
    const f = await fixture();
    const userConfigPath = join(f.homeDir, ".ratel", "config.json");
    await mkdir(join(f.homeDir, ".agents", "skills", "race"), { recursive: true });
    await putSkill(join(f.homeDir, ".agents", "skills", "race"), "race");
    await mkdir(join(f.homeDir, ".ratel"), { recursive: true });
    await writeFile(userConfigPath, '{"skills":{"entries":{}}}\n');
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "race",
    );
    if (!candidate) throw new Error("candidate not discovered");
    const engine = await createMutationEngine({ controlDir: join(f.homeDir, ".ratel") });
    const preparedChanges = createPreparedChangeCoordinator({
      mutationEngine: {
        async prepare(operations) {
          await writeFile(userConfigPath, '{"manual":true,"skills":{"entries":{}}}\n');
          return engine.prepare(operations);
        },
        commit: (plan, options) => engine.commit(plan, options),
        recover: () => engine.recover(),
      },
    });
    const racingControlPlane = createSkillImportControlPlane({
      homeDir: f.homeDir,
      projectRegistry: f.projectRegistry,
      discovery: f.discovery,
      preparedChanges,
    });

    await expect(
      racingControlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
        },
      ]),
    ).rejects.toMatchObject({ statusCode: 409, reason: "revision_conflict" });
    expect(await readJson(userConfigPath)).toMatchObject({ manual: true });
  });

  it("rejects a project control symlink introduced after preview", async () => {
    const f = await fixture();
    const source = join(f.projectA, ".agents", "skills", "escape");
    await putSkill(source, "escape");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];
    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: projectScope(f.projectBId), mode: "copy" }],
      },
    ]);
    const outside = await mkdtemp(join(tmpdir(), "ratel-skill-import-outside-"));
    roots.push(outside);
    await symlink(outside, join(f.projectB, ".ratel"));

    await expect(f.controlPlane.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 422,
      code: "PROJECT_PATH_UNSAFE",
    });
    await expect(readFile(join(outside, "config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists relative path and origin when importing a project copy with skillStorage", async () => {
    const f = await fixture({ skillStorage: true });
    const source = join(f.projectA, ".agents", "skills", "demo");
    await putSkill(source, "demo");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: projectScope(f.projectBId), mode: "copy" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    expect(await readJson(join(f.projectB, ".ratel", "config.json"))).toMatchObject({
      skills: {
        entries: {
          demo: {
            mode: "copy",
            origin: "local-managed",
            path: ".ratel/skills/demo",
            source: "codex",
            copiedFrom: { source: "codex-current", id: "demo" },
          },
        },
      },
    });
  });

  it("keeps hostPolicy and adds origin when importing a reference with skillStorage", async () => {
    const f = await fixture({ skillStorage: true });
    await putSkill(join(f.homeDir, ".claude", "skills", "review"), "review");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "review",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    expect(await readJson(join(f.homeDir, ".ratel", "config.json"))).toMatchObject({
      skills: {
        entries: {
          review: {
            mode: "reference",
            origin: "reference",
            path: candidate.canonicalPath,
            source: "claude",
            hostPolicy: { mode: "manual-only", source: "claude" },
          },
        },
      },
    });
  });

  it("leaves sibling entries byte-identical when skillStorage writes a new entry", async () => {
    const f = await fixture({ skillStorage: true });
    const userConfigPath = join(f.homeDir, ".ratel", "config.json");
    const sibling = {
      mode: "reference" as const,
      path: "/opt/existing",
      source: "unknown" as const,
      future: { keep: true },
    };
    await mkdir(join(f.homeDir, ".ratel"), { recursive: true });
    await writeFile(
      userConfigPath,
      `${JSON.stringify(
        {
          skills: {
            entries: { existing: sibling },
            dirs: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    await putSkill(join(f.homeDir, ".claude", "skills", "new-skill"), "new-skill");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "new-skill",
    );
    if (!candidate) throw new Error("candidate not discovered");

    const plan = await f.controlPlane.prepare([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    await f.controlPlane.commit(plan.changeId);

    const document = await readJson(userConfigPath);
    expect((document.skills as { entries: Record<string, unknown> }).entries.existing).toEqual(
      sibling,
    );
  });

  it("snapshots when skillStorage is true even if the env flag is unset", async () => {
    const previous = process.env.RATEL_FEATURE_SKILL_STORAGE;
    delete process.env.RATEL_FEATURE_SKILL_STORAGE;
    try {
      const f = await fixture({ skillStorage: true });
      await putSkill(join(f.homeDir, ".claude", "skills", "review"), "review");
      const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
        ({ id }) => id === "review",
      );
      if (!candidate) throw new Error("candidate not discovered");

      const plan = await f.controlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
        },
      ]);
      const commit = await f.controlPlane.commit(plan.changeId);

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
      const f = await fixture({ skillStorage: false });
      await putSkill(join(f.homeDir, ".claude", "skills", "review"), "review");
      const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
        ({ id }) => id === "review",
      );
      if (!candidate) throw new Error("candidate not discovered");

      const plan = await f.controlPlane.prepare([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
        },
      ]);
      const commit = await f.controlPlane.commit(plan.changeId);

      expect(commit.backupManifest).not.toBeNull();
      expect(commit.backupManifest?.entries.every((entry) => entry.kind === undefined)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      else process.env.RATEL_FEATURE_SKILL_STORAGE = previous;
    }
  });
});
