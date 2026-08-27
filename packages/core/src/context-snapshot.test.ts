import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContextSnapshotResolver, InvalidContextSnapshotError } from "./context-snapshot.js";
import { createProjectRegistry } from "./project-registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ratel-snapshot-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const projectRoot = join(root, "project");
  await mkdir(join(homeDir, ".ratel"), { recursive: true });
  await mkdir(join(projectRoot, ".ratel"), { recursive: true });
  const registry = createProjectRegistry({ homeDir });
  const project = await registry.registerRoot(projectRoot);
  const resolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
  return { homeDir, projectRoot, project, resolver };
}

describe("ContextSnapshotResolver", () => {
  it("resolves lossless scoped documents, MCP provenance, contextual cwd, and revisions", async () => {
    const { homeDir, projectRoot, project, resolver } = await fixture();
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({
        custom: { preserved: true },
        mcpServers: { inherited: { type: "stdio", command: "runner", cwd: "tools" } },
        skills: { dirs: [] },
      }),
    );
    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      JSON.stringify({ mcpServers: { project: { type: "stdio", command: "project-runner" } } }),
    );

    const first = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(first.projectRoot).toBe(project.canonicalRoot);
    expect(first.documents).toHaveLength(2);
    expect(first.documents[0]?.document.custom).toEqual({ preserved: true });
    expect(first.documents.every((document) => document.documentRevision.length > 20)).toBe(true);
    expect(first.mcpEntries.find((entry) => entry.name === "inherited")).toMatchObject({
      owner: { scope: "user" },
      status: "effective",
      runtimeCwd: join(project.canonicalRoot, "tools"),
    });

    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      JSON.stringify({ mcpServers: { project: { type: "stdio", command: "changed" } } }),
    );
    const second = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(second.runtimeRevision).not.toBe(first.runtimeRevision);
    expect(second.documents[1]?.documentRevision).not.toBe(first.documents[1]?.documentRevision);
  });

  it("includes effective skill resources in the runtime revision", async () => {
    const { projectRoot, project, resolver } = await fixture();
    const skillDir = join(projectRoot, ".agents", "skills", "audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Audit a codebase\n---\n\nRead the bundled guide.",
    );
    await writeFile(join(skillDir, "guide.md"), "version one");
    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      JSON.stringify({
        mcpServers: {},
        skills: { entries: { audit: { mode: "reference", path: ".agents/skills/audit" } } },
      }),
    );

    const first = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(first.skills.effectiveSkills[0]?.body).toContain("guide.md");
    await writeFile(join(skillDir, "guide.md"), "version two");
    const second = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(second.runtimeRevision).not.toBe(first.runtimeRevision);
  });

  it("changes runtime revision when an MCP URL resolves to a different environment target", async () => {
    const { homeDir, project } = await fixture();
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: ["https://$", "{MCP_HOST}/mcp"].join("") },
        },
        skills: { dirs: [] },
      }),
    );
    const registry = createProjectRegistry({ homeDir });
    const firstResolver = createContextSnapshotResolver({
      homeDir,
      projectRegistry: registry,
      env: { MCP_HOST: "first.example" },
    });
    const secondResolver = createContextSnapshotResolver({
      homeDir,
      projectRegistry: registry,
      env: { MCP_HOST: "second.example" },
    });

    const first = await firstResolver.resolve({ kind: "project", projectId: project.id });
    const second = await secondResolver.resolve({ kind: "project", projectId: project.id });

    expect(first.runtimeRevision).not.toBe(second.runtimeRevision);
  });

  it("resolves retrieval atomically by scope and includes it in the runtime revision", async () => {
    const { homeDir, projectRoot, project, resolver } = await fixture();
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({
        retrieval: {
          method: "semantic",
          embedding: { huggingface: "intfloat/e5-small-v2", download: false },
        },
      }),
    );

    const inherited = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(inherited.retrieval).toEqual({
      method: "semantic",
      embedding: { huggingface: "intfloat/e5-small-v2", download: false },
    });

    await writeFile(
      join(projectRoot, ".ratel", "config.json"),
      JSON.stringify({
        retrieval: {
          method: "hybrid",
          embedding: { ollama: "nomic-embed-text" },
        },
      }),
    );
    const overridden = await resolver.resolve({ kind: "project", projectId: project.id });

    expect(overridden.retrieval).toEqual({
      method: "hybrid",
      embedding: { ollama: "nomic-embed-text" },
    });
    expect(overridden.runtimeRevision).not.toBe(inherited.runtimeRevision);
  });

  it("changes runtime revision when effective OAuth state changes", async () => {
    const { homeDir, resolver } = await fixture();
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "https://remote.example/mcp" },
        },
      }),
    );

    const before = await resolver.resolve({ kind: "global" });
    const remote = before.mcpEntries.find(({ name }) => name === "remote");
    if (!remote) throw new Error("expected resolved OAuth entry");
    const { path: oauthPath, fingerprint: resourceFingerprint } = remote.oauthKey;
    expect(before.watchInputs).toContainEqual({ path: oauthPath, kind: "file" });

    await mkdir(dirname(oauthPath), { recursive: true });
    await writeFile(
      oauthPath,
      JSON.stringify({
        resource_fingerprint: resourceFingerprint,
        code_verifier: "authorization-in-progress",
      }),
    );
    const inProgress = await resolver.resolve({ kind: "global" });
    expect(inProgress.runtimeRevision).toBe(before.runtimeRevision);

    await writeFile(
      oauthPath,
      JSON.stringify({
        resource_fingerprint: resourceFingerprint,
        tokens: { access_token: "authorized", token_type: "Bearer" },
      }),
    );

    const after = await resolver.resolve({ kind: "global" });
    expect(after.runtimeRevision).not.toBe(before.runtimeRevision);
  });

  it("fails a new snapshot explicitly when a scoped config is invalid", async () => {
    const { homeDir, resolver } = await fixture();
    await writeFile(join(homeDir, ".ratel", "config.json"), "{not json");

    await expect(resolver.resolve({ kind: "global" })).rejects.toBeInstanceOf(
      InvalidContextSnapshotError,
    );
  });

  it("adds Cloud skills, lets a local skill of the same id win, and says which was shadowed", async () => {
    const { homeDir, project } = await fixture();
    await mkdir(join(homeDir, ".ratel", "skills", "shared"), { recursive: true });
    await writeFile(
      join(homeDir, ".ratel", "skills", "shared", "SKILL.md"),
      "---\nname: shared\ndescription: the local copy\n---\n\nlocal body\n",
    );
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({ skills: { dirs: [join(homeDir, ".ratel", "skills")] } }),
    );
    const registry = createProjectRegistry({ homeDir });
    const resolver = createContextSnapshotResolver({
      homeDir,
      projectRegistry: registry,
      cloudCatalog: async () => ({
        catalogVersion: "v1",
        skills: [
          { id: "shared", name: "shared", description: "the published copy", body: "cloud" },
          { id: "cloud-only", name: "cloud-only", description: "published", body: "cloud" },
        ],
      }),
    });

    const snapshot = await resolver.resolve({ kind: "project", projectId: project.id });
    const byId = new Map(snapshot.skills.effectiveSkills.map((skill) => [skill.id, skill]));
    expect([...byId.keys()].sort()).toEqual(["cloud-only", "shared"]);
    expect(byId.get("shared")?.description).toBe("the local copy");
    const shadowed = snapshot.diagnostics.find((d) => d.code === "cloud-skill-shadowed");
    expect(shadowed?.severity).toBe("warning");
    expect(shadowed?.message).toContain('"shared"');
    expect(shadowed?.message).toContain("Remove or rename the local skill");
  });

  it("changes the runtime revision when only the Cloud catalog version changes", async () => {
    const { homeDir, project } = await fixture();
    const registry = createProjectRegistry({ homeDir });
    const resolverFor = (catalogVersion: string) =>
      createContextSnapshotResolver({
        homeDir,
        projectRegistry: registry,
        cloudCatalog: async () => ({ catalogVersion, skills: [] }),
      });

    const context = { kind: "project" as const, projectId: project.id };
    const first = await resolverFor("v1").resolve(context);
    const same = await resolverFor("v1").resolve(context);
    const later = await resolverFor("v2").resolve(context);

    expect(same.runtimeRevision).toBe(first.runtimeRevision);
    expect(later.runtimeRevision).not.toBe(first.runtimeRevision);
  });

  it("pulls the Cloud catalog once per resolve, and again on the next one", async () => {
    // The memo lives inside `resolve`. Hoisting it would make a published
    // change invisible until the daemon restarted.
    const { homeDir, project } = await fixture();
    const registry = createProjectRegistry({ homeDir });
    const pulls: Array<string | undefined> = [];
    const resolver = createContextSnapshotResolver({
      homeDir,
      projectRegistry: registry,
      cloudCatalog: async (_context, profile) => {
        pulls.push(profile);
        return { catalogVersion: `v${pulls.length}`, skills: [] };
      },
    });

    const context = { kind: "project" as const, projectId: project.id };
    const first = await resolver.resolve(context);
    const second = await resolver.resolve(context);

    expect(pulls).toHaveLength(2);
    expect(second.runtimeRevision).not.toBe(first.runtimeRevision);
  });

  it("reports a failed Cloud pull as a warning instead of failing the resolve", async () => {
    const { homeDir, project } = await fixture();
    const resolver = createContextSnapshotResolver({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
      cloudCatalog: async () => {
        throw new Error('Cloud profile "acme" (cloud.profile) is not in cloud.json');
      },
    });

    const snapshot = await resolver.resolve({ kind: "project", projectId: project.id });

    const failed = snapshot.diagnostics.find((d) => d.code === "cloud-catalog-unavailable");
    expect(failed?.severity).toBe("warning");
    expect(failed?.message).toContain('"acme" (cloud.profile)');
    expect(snapshot.skills.effectiveSkills).toEqual([]);
  });

  it("resolves without a Cloud catalog at all", async () => {
    const { project, resolver } = await fixture();
    const snapshot = await resolver.resolve({ kind: "project", projectId: project.id });
    expect(snapshot.skills.effectiveSkills).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
  });
});
