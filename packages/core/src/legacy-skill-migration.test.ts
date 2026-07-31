import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createConfigControlPlane } from "./config-control-plane.js";
import { migrateLegacySkillLinks } from "./legacy-skill-migration.js";
import { createMutationEngine } from "./mutation-engine.js";
import { createPreparedChangeCoordinator } from "./prepared-change-coordinator.js";
import { createProjectRegistry } from "./project-registry.js";

describe("legacy skill migration", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("atomically converts a verified legacy link into a scoped reference", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-legacy-skill-"));
    homes.push(homeDir);
    const native = join(homeDir, ".claude", "skills", "review");
    const managed = join(homeDir, ".ratel", "skills", "review");
    const manifestPath = join(homeDir, ".ratel", "skill-manifest.json");
    const configPath = join(homeDir, ".ratel", "config.json");
    const before = "---\nname: review\ndescription: Review\n---\n\nBody\n";
    const after =
      "---\nname: review\ndescription: Review\ndisable-model-invocation: true\n---\n\nBody\n";
    await mkdir(native, { recursive: true });
    await mkdir(join(homeDir, ".ratel", "skills"), { recursive: true });
    await writeFile(join(native, "SKILL.md"), after);
    await symlink(native, managed);
    await writeFile(configPath, '{"skills":{"entries":{}}}\n');
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 1,
        managed: [
          {
            id: "review",
            mode: "linked",
            originalPath: native,
            linkPath: managed,
            source: "claude",
            metadataPatch: [{ path: join(native, "SKILL.md"), before, after }],
          },
        ],
      })}\n`,
    );
    const preparedChanges = createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
    });
    const projectRegistry = createProjectRegistry({ homeDir });
    const configControlPlane = await createConfigControlPlane({
      homeDir,
      projectRegistry,
      preparedChanges,
    });

    const commit = await migrateLegacySkillLinks({
      homeDir,
      configControlPlane,
      preparedChanges,
    });

    expect(commit?.result.migrated).toEqual(["review"]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      skills: {
        entries: {
          review: {
            mode: "reference",
            source: "claude",
            hostPolicy: { mode: "manual-only", source: "claude" },
          },
        },
      },
    });
    await expect(lstat(managed)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(native, "SKILL.md"), "utf8")).toBe(after);
  });

  it("does not trust a legacy metadata patch outside the native skill", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-legacy-skill-"));
    homes.push(homeDir);
    const native = join(homeDir, ".claude", "skills", "review");
    const managed = join(homeDir, ".ratel", "skills", "review");
    const manifestPath = join(homeDir, ".ratel", "skill-manifest.json");
    const unrelated = join(homeDir, "unrelated.txt");
    await mkdir(native, { recursive: true });
    await mkdir(join(homeDir, ".ratel", "skills"), { recursive: true });
    await writeFile(
      join(native, "SKILL.md"),
      "---\nname: review\ndescription: Review\ndisable-model-invocation: true\n---\n",
    );
    await writeFile(unrelated, "do not trust this path\n");
    await symlink(native, managed);
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 1,
        managed: [
          {
            id: "review",
            mode: "linked",
            originalPath: native,
            source: "claude",
            metadataPatch: [{ path: unrelated, after: "do not trust this path\n" }],
          },
        ],
      })}\n`,
    );
    const preparedChanges = createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({ controlDir: join(homeDir, ".ratel") }),
    });
    const configControlPlane = await createConfigControlPlane({
      homeDir,
      projectRegistry: createProjectRegistry({ homeDir }),
      preparedChanges,
    });

    const commit = await migrateLegacySkillLinks({
      homeDir,
      configControlPlane,
      preparedChanges,
    });

    expect(commit).toBeNull();
    expect((await lstat(managed)).isSymbolicLink()).toBe(true);
    expect(await readFile(unrelated, "utf8")).toBe("do not trust this path\n");
    expect(await readFile(manifestPath, "utf8")).toContain(unrelated);
  });
});
