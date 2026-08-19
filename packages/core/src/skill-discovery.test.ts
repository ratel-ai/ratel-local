import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillDiscovery, StaleSkillCandidateError } from "./skill-discovery.js";

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

describe("SkillDiscovery", () => {
  it("inventories all global native sources with opaque candidate ids", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-discovery-home-"));
    roots.push(homeDir);
    await putSkill(join(homeDir, ".claude", "skills", "claude-one"), "claude-one");
    await putSkill(join(homeDir, ".agents", "skills", "codex-current"), "codex-current");
    await putSkill(join(homeDir, ".codex", "skills", "codex-legacy"), "codex-legacy");
    await putSkill(join(homeDir, ".ratel", "skills", "ratel-one"), "ratel-one");

    const discovery = createSkillDiscovery({ homeDir });
    const result = await discovery.discover({ kind: "global" });

    expect(result.candidates.map(({ source, id }) => [source, id])).toEqual([
      ["claude", "claude-one"],
      ["codex-current", "codex-current"],
      ["codex-legacy", "codex-legacy"],
      ["ratel", "ratel-one"],
    ]);
    expect(result.candidates.every(({ candidateId }) => /^cand_[\w-]{43}$/.test(candidateId))).toBe(
      true,
    );
  });

  it("walks projects deterministically without ignored or symlink directories", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-discovery-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-discovery-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ratel-discovery-outside-"));
    roots.push(homeDir, projectRoot, outside);
    await putSkill(join(projectRoot, "packages", "b", ".agents", "skills", "b-skill"), "b-skill");
    await putSkill(join(projectRoot, "packages", "a", ".claude", "skills", "a-skill"), "a-skill");
    await putSkill(
      join(projectRoot, "node_modules", "x", ".agents", "skills", "ignored"),
      "ignored",
    );
    await putSkill(join(outside, ".agents", "skills", "escaped"), "escaped");
    await symlink(outside, join(projectRoot, "linked-outside"));

    const discovery = createSkillDiscovery({ homeDir });
    const result = await discovery.discover({ kind: "project", projectRoot });

    expect(result.candidates.map(({ id }) => id)).toEqual(["a-skill", "b-skill"]);
    expect(result.truncated).toBe(false);
  });

  it("revalidates a cached candidate before import", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-discovery-home-"));
    roots.push(homeDir);
    const path = join(homeDir, ".agents", "skills", "demo");
    await putSkill(path, "demo", "one");
    const discovery = createSkillDiscovery({ homeDir });
    const candidate = (await discovery.discover({ kind: "global" })).candidates[0];
    expect((await discovery.resolveCandidate(candidate.candidateId)).id).toBe("demo");

    await putSkill(path, "demo", "two");
    await expect(discovery.resolveCandidate(candidate.candidateId)).rejects.toBeInstanceOf(
      StaleSkillCandidateError,
    );
  });
});
