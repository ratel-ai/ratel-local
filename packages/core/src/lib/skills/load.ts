import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@ratel-ai/sdk";

/** The Ratel-managed skill folder scanned by default. */
export function defaultSkillDirs(): string[] {
  return [join(homedir(), ".ratel", "skills")];
}

export interface LoadSkillsOptions {
  logger?: (message: string) => void;
}

/**
 * Scan Ratel-managed skill directories and return the discovered skills.
 *
 * Each `<dir>/<name>/SKILL.md` becomes one {@link Skill}: frontmatter supplies
 * `name` / `description` / `tags`; the Markdown body is the dispatch payload,
 * with any bundled `scripts/` and sibling `*.md` files appended as absolute
 * paths so the agent can reach them after `get_skill_content`.
 *
 * Loading is fail-soft per skill: a malformed `SKILL.md` is logged and skipped,
 * never crashing gateway boot. Missing directories are silently ignored. When
 * the same skill id appears in multiple directories, the later directory wins.
 */
export async function loadSkills(
  dirs: string[],
  options: LoadSkillsOptions = {},
): Promise<Skill[]> {
  const log = options.logger ?? (() => {});
  const byId = new Map<string, Skill>();

  for (const rawDir of dirs) {
    const dir = expandHome(rawDir);
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        log(`[ratel] could not read skills dir ${dir}: ${(err as Error).message}`);
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(dir, entry.name);
      const skillMd = join(skillDir, "SKILL.md");

      let raw: string;
      try {
        raw = await readFile(skillMd, "utf8");
      } catch (err) {
        // A subdirectory without a SKILL.md simply isn't a skill — ignore it.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log(`[ratel] could not read ${skillMd}: ${(err as Error).message}`);
        }
        continue;
      }

      try {
        const parsed = parseSkillMd(raw, skillMd);
        const body = await appendBundledResources(parsed.body, skillDir);
        if (byId.has(parsed.name)) {
          // Two SKILL.md files declare the same frontmatter `name`; the catalog
          // keys on it, so one would silently shadow the other. Warn — don't hide it.
          log(
            `[ratel] duplicate skill name "${parsed.name}" (${skillMd}) — overriding the earlier one`,
          );
        }
        byId.set(parsed.name, {
          id: parsed.name,
          name: parsed.name,
          description: parsed.description,
          tags: parsed.tags,
          triggers: parsed.triggers,
          stacks: parsed.stacks,
          body,
        });
      } catch (err) {
        log(`[ratel] skipping skill ${entry.name}: ${(err as Error).message}`);
      }
    }
  }

  return Array.from(byId.values());
}

interface ParsedSkill {
  name: string;
  description: string;
  tags: string[];
  /** Author-declared task phrases ("dashboard", "login form"); indexed for the push path. */
  triggers: string[];
  /** Project stacks the skill applies to ("react", "django"); used to boost by context. */
  stacks: string[];
  body: string;
}

/**
 * Parse a `SKILL.md` into frontmatter fields + body. Frontmatter is the block
 * between the leading `---` fences; values are flat inline scalars (the same
 * constraint Claude Code's skill validator enforces).
 */
export function parseSkillMd(raw: string, source: string): ParsedSkill {
  const fm = extractFrontmatter(raw);
  if (!fm) {
    throw new SkillLoadError(`${source}: missing YAML frontmatter`);
  }
  const name = typeof fm.data.name === "string" ? fm.data.name : undefined;
  if (!name) {
    throw new SkillLoadError(`${source}: frontmatter 'name' is required`);
  }
  const description = typeof fm.data.description === "string" ? fm.data.description : undefined;
  if (!description) {
    throw new SkillLoadError(`${source}: frontmatter 'description' is required`);
  }
  return {
    name,
    description,
    tags: parseList(fm.data.tags),
    triggers: parseList(fm.data.triggers),
    stacks: parseList(fm.data.stacks),
    body: fm.body.trim(),
  };
}

interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
}

function extractFrontmatter(raw: string): Frontmatter | undefined {
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (lines[i]?.trim() !== "---") return undefined;
  const start = i + 1;
  let end = -1;
  for (let j = start; j < lines.length; j++) {
    if (lines[j].trim() === "---") {
      end = j;
      break;
    }
  }
  if (end === -1) return undefined;

  const data: Record<string, string | string[]> = {};
  const fmLines = lines.slice(start, end);
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (!key) continue;
    const value = line.slice(sep + 1).trim();
    if (value !== "") {
      data[key] = stripQuotes(value);
      continue;
    }
    // An empty inline value may be followed by a YAML *block* list on indented
    // `- item` lines. Collect them so `triggers:`/`stacks:`/`tags:` written in the
    // common block style aren't silently dropped (they'd otherwise parse to []).
    const items: string[] = [];
    while (j + 1 < fmLines.length && /^\s*-\s+/.test(fmLines[j + 1])) {
      items.push(stripQuotes(fmLines[j + 1].replace(/^\s*-\s+/, "").trim()));
      j++;
    }
    data[key] = items;
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

function parseList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map((t) => stripQuotes(t.trim())).filter((t) => t.length > 0);
  }
  if (value === "") return [];
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((t) => stripQuotes(t.trim()))
    .filter((t) => t.length > 0);
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Append an absolute-path index of bundled resources (a `scripts/` directory
 * and any sibling `*.md` reference files) so the agent can run or read them
 * once the body is in context. Returns the body unchanged when there are none.
 */
async function appendBundledResources(body: string, skillDir: string): Promise<string> {
  const resources: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(skillDir, { withFileTypes: true });
  } catch {
    return body;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === "scripts") {
      try {
        const scripts = await readdir(join(skillDir, "scripts"), { withFileTypes: true });
        for (const s of scripts) {
          if (s.isFile()) resources.push(join(skillDir, "scripts", s.name));
        }
      } catch {
        // ignore an unreadable scripts dir
      }
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      resources.push(join(skillDir, entry.name));
    }
  }

  if (resources.length === 0) return body;
  const list = resources.map((p) => `- ${p}`).join("\n");
  return `${body}\n\n---\n\n## Bundled resources (absolute paths)\n\n${list}\n`;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}
