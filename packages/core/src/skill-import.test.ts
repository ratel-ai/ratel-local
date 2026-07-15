import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId, RatelScopeRef } from "./context.js";
import { createMutationEngine } from "./mutation-engine.js";
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

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "ratel-skill-import-home-"));
  const projectA = await mkdtemp(join(tmpdir(), "ratel-skill-import-a-"));
  const projectB = await mkdtemp(join(tmpdir(), "ratel-skill-import-b-"));
  roots.push(homeDir, projectA, projectB);

  const projectRegistry = createProjectRegistry({ homeDir });
  const registeredA = await projectRegistry.registerRoot(projectA, "A");
  const registeredB = await projectRegistry.registerRoot(projectB, "B");
  const discovery = createSkillDiscovery({ homeDir });
  const mutationEngine = await createMutationEngine({
    controlDir: join(homeDir, ".ratel"),
  });
  const controlPlane = createSkillImportControlPlane({
    homeDir,
    projectRegistry,
    discovery,
    mutationEngine,
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
  it("imports one project candidate by reference in A and copy in B in one transaction", async () => {
    const f = await fixture();
    const source = join(f.projectA, ".agents", "skills", "demo");
    await putSkill(source, "demo");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];

    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [
          { scopeRef: projectScope(f.projectAId), mode: "reference" },
          { scopeRef: projectScope(f.projectBId), mode: "copy" },
        ],
      },
    ]);

    expect(plan.mutationPlan.operations.map(({ kind }) => kind).sort()).toEqual([
      "copy-directory",
      "replace-file",
      "replace-file",
    ]);

    const submittedPlan = JSON.parse(JSON.stringify(plan)) as typeof plan;
    const commit = await f.controlPlane.apply(submittedPlan, { digest: plan.digest });

    expect(commit.transactionId).toBe(plan.mutationPlan.id);
    expect(commit.imported).toEqual([
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

    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);

    expect(plan.mutationPlan.operations.map(({ kind }) => kind)).toEqual([
      "replace-file",
      "replace-file",
    ]);
    await f.controlPlane.apply(plan, { digest: plan.digest });
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

    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "copy" }],
      },
    ]);
    await putSkill(source, "stale", "after");

    await expect(f.controlPlane.apply(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      reason: "stale_candidate",
      candidateId: candidate.candidateId,
    } satisfies Partial<SkillImportConflictError>);
  });

  it("rejects a client-modified or replayed import preview", async () => {
    const f = await fixture();
    await putSkill(join(f.homeDir, ".agents", "skills", "secure"), "secure");
    const candidate = (await f.discovery.discover({ kind: "global" })).candidates.find(
      ({ id }) => id === "secure",
    );
    if (!candidate) throw new Error("candidate not discovered");
    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    const modified = structuredClone(plan);
    const replacement = modified.mutationPlan.operations.find(
      (operation) => operation.kind === "replace-file",
    );
    if (!replacement || replacement.kind !== "replace-file") throw new Error("missing config op");
    replacement.contentsBase64 = Buffer.from("forged", "utf8").toString("base64");

    await expect(f.controlPlane.apply(modified, { digest: modified.digest })).rejects.toMatchObject(
      {
        statusCode: 409,
        reason: "digest_mismatch",
      },
    );
    await f.controlPlane.apply(plan, { digest: plan.digest });
    await expect(f.controlPlane.apply(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      reason: "digest_mismatch",
    });
  });

  it("rejects a reference from project A into project B", async () => {
    const f = await fixture();
    await putSkill(join(f.projectA, ".claude", "skills", "local-only"), "local-only");
    const candidate = (await f.discovery.discover({ kind: "project", projectRoot: f.projectA }))
      .candidates[0];

    await expect(
      f.controlPlane.preview([
        {
          candidateId: candidate.candidateId,
          targets: [{ scopeRef: projectScope(f.projectBId), mode: "reference" }],
        },
      ]),
    ).rejects.toBeInstanceOf(SkillImportValidationError);
  });

  it("preserves unknown document and skills fields plus existing registrations", async () => {
    const f = await fixture();
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

    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: { scope: "user" }, mode: "reference" }],
      },
    ]);
    await f.controlPlane.apply(plan, { digest: plan.digest });

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
          },
        },
      },
    });
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
    const racingControlPlane = createSkillImportControlPlane({
      homeDir: f.homeDir,
      projectRegistry: f.projectRegistry,
      discovery: f.discovery,
      mutationEngine: {
        async preview(operations) {
          await writeFile(userConfigPath, '{"manual":true,"skills":{"entries":{}}}\n');
          return engine.preview(operations);
        },
        apply: (plan, options) => engine.apply(plan, options),
        recover: () => engine.recover(),
      },
    });

    await expect(
      racingControlPlane.preview([
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
    const plan = await f.controlPlane.preview([
      {
        candidateId: candidate.candidateId,
        targets: [{ scopeRef: projectScope(f.projectBId), mode: "copy" }],
      },
    ]);
    const outside = await mkdtemp(join(tmpdir(), "ratel-skill-import-outside-"));
    roots.push(outside);
    await symlink(outside, join(f.projectB, ".ratel"));

    await expect(f.controlPlane.apply(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 422,
      code: "PROJECT_PATH_UNSAFE",
    });
    await expect(readFile(join(outside, "config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
