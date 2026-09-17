import { constants } from "node:fs";
import {
  access,
  chmod,
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
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectId } from "./context.js";
import { loadSkillBundle } from "./lib/skills/load.js";
import {
  availabilityFromResolveFailure,
  configuredSkillStoragePath,
  originFromEntry,
  originFromMode,
  type SkillAvailability,
  skillStorageFrom,
  storageKindFromOrigin,
  syncFromOrigin,
} from "./skill-registration.js";

const cleanups: string[] = [];
const chmodRestore: string[] = [];

afterEach(async () => {
  for (const path of chmodRestore.splice(0)) {
    try {
      await chmod(path, 0o755);
    } catch {
      // best-effort
    }
  }
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ratel-skill-reg-"));
  cleanups.push(dir);
  return dir;
}

async function writeSkill(
  dir: string,
  id: string,
  description: string,
  body: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
}

async function availabilityFromLoad(
  configuredPath: string,
  registrationId?: string,
): Promise<SkillAvailability> {
  try {
    const canonicalPath = await realpath(configuredPath);
    await loadSkillBundle(canonicalPath, registrationId);
    return "available";
  } catch (error) {
    return availabilityFromResolveFailure(error, configuredPath);
  }
}

async function skillDirectoryReadable(configuredPath: string): Promise<boolean> {
  try {
    await access(configuredPath, constants.R_OK | constants.X_OK);
    await readFile(join(configuredPath, "SKILL.md"), "utf8");
    return true;
  } catch {
    return false;
  }
}

describe("skill registration helpers", () => {
  it("maps mode to origin and storage kind", () => {
    expect(originFromMode("copy")).toBe("local-managed");
    expect(originFromMode("reference")).toBe("reference");
    expect(originFromEntry({ mode: "copy" })).toBe("local-managed");
    expect(originFromEntry({ mode: "copy", origin: "cloud-managed" })).toBe("cloud-managed");
    expect(storageKindFromOrigin("local-managed")).toBe("managed-copy");
    expect(storageKindFromOrigin("reference")).toBe("external");
    expect(storageKindFromOrigin("cloud-managed")).toBe("cloud-replica");
    expect(storageKindFromOrigin("cloud-detached")).toBe("cloud-replica");
    expect(skillStorageFrom("reference", "/tmp/skill")).toEqual({
      kind: "external",
      path: "/tmp/skill",
    });
    expect(syncFromOrigin("reference")).toBeUndefined();
    expect(syncFromOrigin("cloud-managed")).toBeUndefined();
    expect(syncFromOrigin("cloud-detached")).toBe("disabled");
  });

  it("derives copy paths by scope and prefers a persisted path", () => {
    const homeDir = "/home/u";
    const projectRoot = "/repo";
    const projectId = "prj_test" as ProjectId;

    expect(
      configuredSkillStoragePath({
        homeDir,
        scopeRef: { scope: "user" },
        id: "demo",
        mode: "copy",
      }),
    ).toBe(join(homeDir, ".ratel", "skills", "demo"));

    expect(
      configuredSkillStoragePath({
        homeDir,
        projectRoot,
        scopeRef: { scope: "project", projectId },
        id: "demo",
        mode: "copy",
      }),
    ).toBe(join(projectRoot, ".ratel", "skills", "demo"));

    expect(
      configuredSkillStoragePath({
        homeDir,
        projectRoot,
        scopeRef: { scope: "local", projectId },
        id: "demo",
        mode: "copy",
      }),
    ).toBe(join(projectRoot, ".ratel", "skills.local", "demo"));

    const persisted = join(homeDir, ".ratel", "skills-alt", "demo");
    expect(
      configuredSkillStoragePath({
        homeDir,
        scopeRef: { scope: "user" },
        id: "demo",
        mode: "copy",
        path: persisted,
      }),
    ).toBe(persisted);
  });
});

describe("availabilityFromResolveFailure", () => {
  it("reports available for a valid skill directory", async () => {
    const root = await tempDir();
    const skillDir = join(root, "ok");
    await writeSkill(skillDir, "ok", "Ok skill", "Body.");
    await expect(availabilityFromLoad(skillDir, "ok")).resolves.toBe("available");
  });

  it("reports not-found for a missing directory", async () => {
    const root = await tempDir();
    const missing = join(root, "missing");
    await expect(availabilityFromLoad(missing, "missing")).resolves.toBe("not-found");
  });

  it.skipIf(process.platform === "win32")("reports not-found for a dangling symlink", async () => {
    const root = await tempDir();
    const link = join(root, "dangling");
    await symlink(join(root, "nowhere"), link);
    await expect(availabilityFromLoad(link, "dangling")).resolves.toBe("not-found");
  });

  it("reports invalid when SKILL.md is missing or malformed", async () => {
    const root = await tempDir();
    const emptyDir = join(root, "empty");
    await mkdir(emptyDir);
    await expect(availabilityFromLoad(emptyDir, "empty")).resolves.toBe("invalid");

    const badFm = join(root, "bad");
    await mkdir(badFm);
    await writeFile(join(badFm, "SKILL.md"), "no frontmatter\n", "utf8");
    await expect(availabilityFromLoad(badFm, "bad")).resolves.toBe("invalid");

    const mismatch = join(root, "mismatch");
    await writeSkill(mismatch, "other", "Mismatch", "Body.");
    await expect(availabilityFromLoad(mismatch, "mismatch")).resolves.toBe("invalid");
  });

  it("reports invalid for ENOTDIR when the path is a file", async () => {
    const root = await tempDir();
    const filePath = join(root, "not-a-dir");
    await writeFile(filePath, "x", "utf8");
    await expect(availabilityFromLoad(filePath, "not-a-dir")).resolves.toBe("invalid");
    const enotdir = Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    await expect(availabilityFromResolveFailure(enotdir, filePath)).resolves.toBe("invalid");
  });

  it.skipIf((process.getuid?.() ?? 1) === 0 || process.platform === "win32")(
    "reports inaccessible when the skill directory cannot be read",
    async ({ skip }) => {
      const root = await tempDir();
      const skillDir = join(root, "locked");
      await writeSkill(skillDir, "locked", "Locked", "Body.");
      chmodRestore.push(skillDir);
      await chmod(skillDir, 0o000);
      if (await skillDirectoryReadable(skillDir)) {
        skip();
      }
      await expect(availabilityFromLoad(skillDir, "locked")).resolves.toBe("inaccessible");
    },
  );
});
