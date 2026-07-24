import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigControlPlane } from "./config-control-plane.js";
import { MISSING_DOCUMENT_REVISION } from "./mutation-engine.js";
import { createProjectRegistry } from "./project-registry.js";

describe("ConfigControlPlane", () => {
  let root: string;
  let homeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ratel-config-control-"));
    homeDir = join(root, "home");
    projectRoot = join(root, "project");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await mkdir(projectRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("mutates only the selected node in a skills-only document", async () => {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify({ custom: { keep: true }, skills: { dirs: [] } }, null, 2)}\n`,
    );
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
    });

    const preview = await control.prepareServerMutation({
      target: { scope: "user" },
      action: "add",
      name: "filesystem",
      entry: { type: "stdio", command: "node" },
    });
    await control.commit(preview.changeId);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      custom: { keep: true },
      skills: { dirs: [] },
      mcpServers: { filesystem: { type: "stdio", command: "node" } },
    });
  });

  it("configures retrieval without disturbing unrelated scoped settings", async () => {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          custom: { keep: true },
          mcpServers: { filesystem: { type: "stdio", command: "node" } },
        },
        null,
        2,
      )}\n`,
    );
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
    });

    const preview = await control.prepareRetrievalMutation({
      target: { scope: "user" },
      action: "configure",
      retrieval: {
        method: "hybrid",
        embedding: { huggingface: "intfloat/e5-small-v2", download: false },
      },
    });
    expect(preview.preview).toMatchObject({
      action: "configure",
      target: { scope: "user" },
      retrieval: {
        method: "hybrid",
        embedding: { huggingface: "intfloat/e5-small-v2", download: false },
      },
    });
    await control.commit(preview.changeId);

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      custom: { keep: true },
      mcpServers: { filesystem: { type: "stdio", command: "node" } },
      retrieval: {
        method: "hybrid",
        embedding: { huggingface: "intfloat/e5-small-v2", download: false },
      },
    });
  });

  it("resets only the retrieval override and keeps the selected scope document", async () => {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          mcpServers: { filesystem: { type: "stdio", command: "node" } },
          retrieval: { method: "semantic" },
        },
        null,
        2,
      )}\n`,
    );
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
    });

    await control.mutateRetrieval({
      target: { scope: "user" },
      action: "reset",
    });

    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      mcpServers: { filesystem: { type: "stdio", command: "node" } },
    });
  });

  it("applies retrieval revision safeguards and local Git-exclude preparation", async () => {
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const excludePath = join(projectRoot, ".git", "info", "exclude");
    await mkdir(join(projectRoot, ".git", "info"), { recursive: true });
    const ensuredRoots: string[] = [];
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      localGitExcludeManager: {
        async preview(root) {
          ensuredRoots.push(root);
          return {
            projectRoot: root,
            excludePath,
            changed: true,
            currentContents: null,
            contents: "# ratel local\n",
            documentRevision: MISSING_DOCUMENT_REVISION,
          };
        },
        async ensure(root) {
          return { projectRoot: root, excludePath, changed: true };
        },
      },
    });
    const current = await control.read({ scope: "local", projectId: project.id });

    const commit = await control.mutateRetrieval({
      target: { scope: "local", projectId: project.id },
      expectedRevision: current.documentRevision,
      action: "configure",
      retrieval: { method: "semantic" },
    });

    expect(commit.changedPaths).toEqual([
      join(project.canonicalRoot, ".ratel", "config.local.json"),
      excludePath,
    ]);
    expect(ensuredRoots).toEqual([project.canonicalRoot]);
    await expect(
      control.prepareRetrievalMutation({
        target: { scope: "local", projectId: project.id },
        expectedRevision: current.documentRevision,
        action: "reset",
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "revision_conflict" });
  });

  it("targets project/local files only through a registered ProjectId", async () => {
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const ensuredRoots: string[] = [];
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      localGitExcludeManager: {
        async preview(root) {
          ensuredRoots.push(root);
          return {
            projectRoot: root,
            excludePath: join(root, ".git", "info", "exclude"),
            changed: true,
            currentContents: null,
            contents: "# ratel local\n",
            documentRevision: MISSING_DOCUMENT_REVISION,
          };
        },
        async ensure(root) {
          return {
            projectRoot: root,
            excludePath: join(root, ".git", "info", "exclude"),
            changed: true,
          };
        },
      },
    });

    const commit = await control.mutateServer({
      target: { scope: "local", projectId: project.id },
      action: "add",
      name: "local",
      entry: { type: "stdio", command: "local" },
    });

    expect(commit.changedPaths).toEqual([
      join(project.canonicalRoot, ".ratel", "config.local.json"),
      join(project.canonicalRoot, ".git", "info", "exclude"),
    ]);
    expect(ensuredRoots).toEqual([project.canonicalRoot]);
  });

  it("returns a typed conflict when expectedRevision is stale", async () => {
    const configPath = join(homeDir, ".ratel", "config.json");
    await writeFile(configPath, '{"mcpServers":{}}\n');
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
    });
    const read = await control.read({ scope: "user" });
    await writeFile(configPath, '{"mcpServers":{"manual":{"type":"stdio","command":"x"}}}\n');

    await expect(
      control.prepareServerMutation({
        target: { scope: "user" },
        expectedRevision: read.documentRevision,
        action: "add",
        name: "filesystem",
        entry: { type: "stdio", command: "node" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "revision_conflict" });
  });

  it("rejects a project control directory that is a symlink outside the root", async () => {
    const outside = join(root, "outside-control");
    await mkdir(outside);
    await symlink(outside, join(projectRoot, ".ratel"));
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const control = await createConfigControlPlane({ homeDir, projectRegistry: registry });

    await expect(control.read({ scope: "project", projectId: project.id })).rejects.toMatchObject({
      statusCode: 422,
      code: "PROJECT_PATH_UNSAFE",
    });
  });

  it("rechecks project containment under the mutation lock after preview", async () => {
    const outside = join(root, "outside-after-preview");
    await mkdir(outside);
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const control = await createConfigControlPlane({ homeDir, projectRegistry: registry });
    const plan = await control.prepareServerMutation({
      target: { scope: "project", projectId: project.id },
      action: "add",
      name: "safe",
      entry: { type: "stdio", command: "echo" },
    });
    await symlink(outside, join(projectRoot, ".ratel"));

    await expect(control.commit(plan.changeId)).rejects.toMatchObject({
      statusCode: 422,
      code: "PROJECT_PATH_UNSAFE",
    });
    await expect(readFile(join(outside, "config.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a Git exclude edit that races between derivation and mutation preview", async () => {
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);
    const excludePath = join(projectRoot, ".git", "info", "exclude");
    await mkdir(join(projectRoot, ".git", "info"), { recursive: true });
    const control = await createConfigControlPlane({
      homeDir,
      projectRegistry: registry,
      localGitExcludeManager: {
        async preview(root) {
          await writeFile(excludePath, "# manual edit\n");
          return {
            projectRoot: root,
            excludePath,
            changed: true,
            currentContents: null,
            contents: "# ratel local\n",
            documentRevision: MISSING_DOCUMENT_REVISION,
          };
        },
        async ensure(root) {
          return { projectRoot: root, excludePath, changed: true };
        },
      },
    });

    await expect(
      control.prepareServerMutation({
        target: { scope: "local", projectId: project.id },
        action: "add",
        name: "local",
        entry: { type: "stdio", command: "echo" },
      }),
    ).rejects.toMatchObject({ statusCode: 409, reason: "revision_conflict" });
    await expect(readFile(excludePath, "utf8")).resolves.toBe("# manual edit\n");
  });
});
