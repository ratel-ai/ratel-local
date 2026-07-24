import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectRegistry, projectIdFromCanonicalRoot } from "./project-registry.js";

describe("ProjectRegistry", () => {
  let homeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "ratel-project-registry-"));
    projectRoot = join(homeDir, "workspace");
    await mkdir(projectRoot);
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("registers a canonical directory in the versioned projects file", async () => {
    const now = new Date("2026-07-15T10:30:00.000Z");
    const registry = createProjectRegistry({ homeDir, now: () => now });

    const project = await registry.registerRoot(projectRoot, "Ratel workspace");

    expect(project).toEqual({
      id: expect.stringMatching(/^prj_[A-Za-z0-9_-]{43}$/),
      canonicalRoot: await realpath(projectRoot),
      displayName: "Ratel workspace",
      lastSeenAt: "2026-07-15T10:30:00.000Z",
    });
    expect(JSON.parse(await readFile(join(homeDir, ".ratel", "projects.json"), "utf8"))).toEqual({
      version: 1,
      projects: { [project.id]: project },
    });
  });

  it("derives the full namespaced SHA-256 project id", () => {
    expect(projectIdFromCanonicalRoot("/workspace/example")).toBe(
      "prj_GX0jTxMDk9-jIhAsKgdEk0plfCNdayhLai-jvZh1KxY",
    );
  });

  it("computes availability when listing without persisting status", async () => {
    const registry = createProjectRegistry({ homeDir });
    const project = await registry.registerRoot(projectRoot);

    expect(await registry.list()).toEqual([{ ...project, status: "available" }]);

    const persisted = JSON.parse(await readFile(join(homeDir, ".ratel", "projects.json"), "utf8"));
    expect(persisted.projects[project.id]).not.toHaveProperty("status");
  });

  it("resolves a persisted project by id", async () => {
    const registered = await createProjectRegistry({ homeDir }).registerRoot(projectRoot);
    const reloadedRegistry = createProjectRegistry({ homeDir });

    await expect(reloadedRegistry.resolve(registered.id)).resolves.toEqual(registered);
  });

  it("touch updates only the persisted last-seen timestamp", async () => {
    const registry = createProjectRegistry({
      homeDir,
      now: () => new Date("2026-07-15T10:30:00.000Z"),
    });
    const registered = await registry.registerRoot(projectRoot, "Workspace");

    await registry.touch(registered.id, new Date("2026-07-16T08:00:00.000Z"));

    await expect(registry.resolve(registered.id)).resolves.toEqual({
      ...registered,
      lastSeenAt: "2026-07-16T08:00:00.000Z",
    });
  });

  it("forget removes only the registry record and leaves the project untouched", async () => {
    const sentinel = join(projectRoot, "keep.txt");
    await writeFile(sentinel, "keep me");
    const registry = createProjectRegistry({ homeDir });
    const registered = await registry.registerRoot(projectRoot);

    await registry.forget(registered.id);

    expect(await registry.list()).toEqual([]);
    expect(await readFile(sentinel, "utf8")).toBe("keep me");
  });

  it("deduplicates aliases that resolve to the same canonical root", async () => {
    const alias = join(homeDir, "workspace-alias");
    await symlink(projectRoot, alias, "dir");
    const registry = createProjectRegistry({ homeDir });

    const fromAlias = await registry.registerRoot(alias);
    const fromCanonicalPath = await registry.registerRoot(projectRoot);

    expect(fromAlias.id).toBe(fromCanonicalPath.id);
    expect(await registry.list()).toHaveLength(1);
    expect((await registry.list())[0].canonicalRoot).toBe(await realpath(projectRoot));
  });

  it("keeps a renamed root as missing and registers its new path separately", async () => {
    const registry = createProjectRegistry({ homeDir });
    const beforeRename = await registry.registerRoot(projectRoot);
    const renamedRoot = join(homeDir, "renamed-workspace");
    await rename(projectRoot, renamedRoot);

    expect(await registry.list()).toEqual([{ ...beforeRename, status: "missing" }]);

    const afterRename = await registry.registerRoot(renamedRoot);
    expect(afterRename.id).not.toBe(beforeRename.id);
    expect((await registry.list()).map(({ id, status }) => ({ id, status }))).toEqual([
      { id: beforeRename.id, status: "missing" },
      { id: afterRename.id, status: "available" },
    ]);
  });

  it("serializes concurrent writers without losing projects", async () => {
    const secondRoot = join(homeDir, "second-workspace");
    await mkdir(secondRoot);
    const firstWriter = createProjectRegistry({ homeDir });
    const secondWriter = createProjectRegistry({ homeDir });

    const [first, second] = await Promise.all([
      firstWriter.registerRoot(projectRoot),
      secondWriter.registerRoot(secondRoot),
    ]);

    expect((await firstWriter.list()).map(({ id }) => id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("never overwrites a corrupted projects file", async () => {
    const filePath = join(homeDir, ".ratel", "projects.json");
    await mkdir(join(homeDir, ".ratel"));
    const corrupted = '{ "version": 1, "projects": ';
    await writeFile(filePath, corrupted);

    await expect(createProjectRegistry({ homeDir }).registerRoot(projectRoot)).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(corrupted);
  });

  it("does not replace a parseable file with an unsupported schema", async () => {
    const filePath = join(homeDir, ".ratel", "projects.json");
    await mkdir(join(homeDir, ".ratel"));
    const unsupported = '{"version":2,"projects":{}}\n';
    await writeFile(filePath, unsupported);

    await expect(createProjectRegistry({ homeDir }).registerRoot(projectRoot)).rejects.toThrow(
      /projects file/i,
    );
    expect(await readFile(filePath, "utf8")).toBe(unsupported);
  });

  it("re-registering a root touches it without discarding its display name", async () => {
    const firstRegistry = createProjectRegistry({
      homeDir,
      now: () => new Date("2026-07-15T10:30:00.000Z"),
    });
    const first = await firstRegistry.registerRoot(projectRoot, "Custom name");
    const secondRegistry = createProjectRegistry({
      homeDir,
      now: () => new Date("2026-07-16T08:00:00.000Z"),
    });

    const second = await secondRegistry.registerRoot(projectRoot);

    expect(second).toEqual({
      ...first,
      lastSeenAt: "2026-07-16T08:00:00.000Z",
    });
    expect(await secondRegistry.list()).toHaveLength(1);
  });
});
