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
});
