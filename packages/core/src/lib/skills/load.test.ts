import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkills, parseSkillMd } from "./load.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ratel-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, contents: string): Promise<string> {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), contents);
  return skillDir;
}

describe("parseSkillMd", () => {
  it("parses frontmatter fields and body", () => {
    const parsed = parseSkillMd(
      `---\nname: api-design\ndescription: REST API patterns\ntags: [backend, api]\n---\n\n# Body\n\ncontent`,
      "x/SKILL.md",
    );
    expect(parsed.name).toBe("api-design");
    expect(parsed.description).toBe("REST API patterns");
    expect(parsed.tags).toEqual(["backend", "api"]);
    expect(parsed.body).toContain("# Body");
  });

  it("strips surrounding quotes from a quoted description", () => {
    const parsed = parseSkillMd(
      `---\nname: x\ndescription: "Quoted: with colon"\n---\nbody`,
      "x/SKILL.md",
    );
    expect(parsed.description).toBe("Quoted: with colon");
  });

  it("throws when name or description is missing", () => {
    expect(() => parseSkillMd(`---\ndescription: d\n---\nbody`, "x")).toThrow(/name/);
    expect(() => parseSkillMd(`---\nname: n\n---\nbody`, "x")).toThrow(/description/);
  });

  it("throws when frontmatter is absent", () => {
    expect(() => parseSkillMd(`# no frontmatter`, "x")).toThrow(/frontmatter/);
  });

  it("parses both inline [a, b] and block-list YAML for triggers/stacks/tags", () => {
    const inline = parseSkillMd(
      `---\nname: n\ndescription: d\ntriggers: [dashboard, login form]\nstacks: [react, next]\n---\nbody`,
      "x",
    );
    expect(inline.triggers).toEqual(["dashboard", "login form"]);
    expect(inline.stacks).toEqual(["react", "next"]);

    // The common YAML block style must NOT silently become [] (it used to).
    const block = parseSkillMd(
      `---\nname: n\ndescription: d\ntriggers:\n  - dashboard\n  - login form\nstacks:\n  - react\n---\nbody`,
      "x",
    );
    expect(block.triggers).toEqual(["dashboard", "login form"]);
    expect(block.stacks).toEqual(["react"]);
  });
});

describe("loadSkills", () => {
  it("loads every well-formed skill in a directory", async () => {
    await writeSkill(
      root,
      "api-design",
      `---\nname: api-design\ndescription: REST patterns\n---\nbody A`,
    );
    await writeSkill(root, "slides", `---\nname: slides\ndescription: build decks\n---\nbody B`);

    const skills = await loadSkills([root]);
    const ids = skills.map((s) => s.id).sort();
    expect(ids).toEqual(["api-design", "slides"]);
  });

  it("ignores a missing directory without throwing", async () => {
    const skills = await loadSkills([join(root, "does-not-exist")]);
    expect(skills).toEqual([]);
  });

  it("skips a malformed skill but keeps the valid ones (fail-soft)", async () => {
    await writeSkill(root, "good", `---\nname: good\ndescription: fine\n---\nok`);
    await writeSkill(root, "bad", `no frontmatter here`);
    const logs: string[] = [];

    const skills = await loadSkills([root], { logger: (m) => logs.push(m) });
    expect(skills.map((s) => s.id)).toEqual(["good"]);
    expect(logs.some((l) => l.includes("bad"))).toBe(true);
  });

  it("ignores subdirectories without a SKILL.md", async () => {
    await mkdir(join(root, "not-a-skill"), { recursive: true });
    await writeSkill(root, "real", `---\nname: real\ndescription: d\n---\nbody`);

    const skills = await loadSkills([root]);
    expect(skills.map((s) => s.id)).toEqual(["real"]);
  });

  it("appends absolute paths for bundled scripts and reference files", async () => {
    const dir = await writeSkill(root, "kit", `---\nname: kit\ndescription: d\n---\nbody`);
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "scan.sh"), "echo hi");
    await writeFile(join(dir, "REFERENCE.md"), "# ref");

    const [skill] = await loadSkills([root]);
    expect(skill.body).toContain("Bundled resources");
    expect(skill.body).toContain(join(dir, "scripts", "scan.sh"));
    expect(skill.body).toContain(join(dir, "REFERENCE.md"));
  });

  it("dedupes by id across directories — the later directory wins", async () => {
    const a = join(root, "a");
    const b = join(root, "b");
    await writeSkill(a, "dup", `---\nname: dup\ndescription: from A\n---\nbody`);
    await writeSkill(b, "dup", `---\nname: dup\ndescription: from B\n---\nbody`);

    const skills = await loadSkills([a, b]);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("from B");
  });
});
