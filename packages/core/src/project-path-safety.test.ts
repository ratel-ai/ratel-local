import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeProjectControlPath, ProjectPathSafetyError } from "./project-path-safety.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("assertSafeProjectControlPath", () => {
  it("accepts missing descendants below a real project directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-safe-project-"));
    roots.push(root);
    await expect(
      assertSafeProjectControlPath(root, join(root, ".ratel", "skills", "demo")),
    ).resolves.toBeUndefined();
  });

  it("rejects prefix traps, dot-dot escapes, and symlinked control directories", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ratel-unsafe-project-"));
    const root = join(parent, "repo");
    const outside = join(parent, "outside");
    roots.push(parent);
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, ".ratel"));

    await expect(
      assertSafeProjectControlPath(root, join(root, ".ratel", "config.json")),
    ).rejects.toBeInstanceOf(ProjectPathSafetyError);
    await expect(
      assertSafeProjectControlPath(root, join(root, "..", "outside", "config.json")),
    ).rejects.toBeInstanceOf(ProjectPathSafetyError);
    await expect(
      assertSafeProjectControlPath(root, `${root}-other/config.json`),
    ).rejects.toBeInstanceOf(ProjectPathSafetyError);
  });

  it("rejects a registered root replaced by a symlink before control paths exist", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ratel-replaced-project-"));
    const root = join(parent, "repo");
    const moved = join(parent, "moved");
    const outside = join(parent, "outside");
    roots.push(parent);
    await mkdir(root);
    await mkdir(outside);
    await rename(root, moved);
    await symlink(outside, root);

    await expect(
      assertSafeProjectControlPath(root, join(root, ".ratel", "config.json")),
    ).rejects.toBeInstanceOf(ProjectPathSafetyError);
  });
});
