import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Skill } from "@ratel-ai/sdk";
import { isDirectoryEntry } from "../fs.js";

/** The Ratel-managed skill folder scanned by default. */
export function defaultSkillDirs(): string[] {
  return [join(homedir(), ".ratel", "skills")];
}

export interface LoadSkillsOptions {
  logger?: (message: string) => void;
  /** Called once per skill that fails to load (e.g. malformed frontmatter), so
   *  callers can surface the problem instead of silently dropping the skill. */
  onProblem?: (problem: { id: string; reason: string }) => void;
}

export interface LoadedSkillBundle {
  skill: Skill;
  fingerprintSource: string;
  watchInputs: string[];
}

/** Load one skill and all resource bytes that contribute to its served body. */
export async function loadSkillBundle(
  skillDir: string,
  registrationId?: string,
): Promise<LoadedSkillBundle> {
  const skillMdPath = join(skillDir, "SKILL.md");
  const raw = await readFile(skillMdPath, "utf8");
  const parsed = parseSkillMd(raw, skillMdPath, registrationId);
  const bundle = await readBundledResources(skillDir);
  return {
    skill: skillFromParsed(parsed, renderBundledResources(parsed.body, bundle.resources)),
    fingerprintSource: JSON.stringify({
      skillMd: raw,
      resources: bundle.resources.map(({ path, contents }) => ({ path, contents })),
    }),
    watchInputs: [dirname(skillDir), skillDir, skillMdPath, ...bundle.watchInputs],
  };
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
      if (!(await isDirectoryEntry(dir, entry))) continue;
      const skillDir = join(dir, entry.name);
      try {
        const bundle = await loadSkillBundle(skillDir);
        if (byId.has(bundle.skill.id)) {
          // Two SKILL.md files declare the same frontmatter `name`; the catalog
          // keys on it, so one would silently shadow the other. Warn — don't hide it.
          log(
            `[ratel] duplicate skill name "${bundle.skill.id}" (${join(skillDir, "SKILL.md")}) — overriding the earlier one`,
          );
        }
        byId.set(bundle.skill.id, bundle.skill);
      } catch (err) {
        // A subdirectory without a SKILL.md simply isn't a skill — ignore it.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        const reason = (err as Error).message;
        log(`[ratel] skipping skill ${entry.name}: ${reason}`);
        options.onProblem?.({ id: entry.name, reason });
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

function skillFromParsed(parsed: ParsedSkill, body: string): Skill {
  return {
    id: parsed.name,
    name: parsed.name,
    description: parsed.description,
    // SDK 0.2.0 collapsed the skill model (ratel ADR-0012): `triggers` fold
    // into `tags` (both indexed phrases), `stacks` move under non-indexed
    // `metadata` carried for the push-path ranker.
    tags: [...parsed.tags, ...parsed.triggers],
    metadata: { stacks: parsed.stacks },
    body,
  };
}

/**
 * Parse a `SKILL.md` into frontmatter fields + body. Frontmatter is the block
 * between the leading `---` fences; values are flat inline scalars (the same
 * constraint Claude Code's skill validator enforces).
 */
export function parseSkillMd(raw: string, source: string, registrationId?: string): ParsedSkill {
  const fm = extractFrontmatter(raw);
  if (!fm) {
    throw new SkillLoadError(`${source}: missing YAML frontmatter`);
  }
  const declaredName = typeof fm.data.name === "string" ? fm.data.name : undefined;
  if (declaredName && registrationId && declaredName !== registrationId) {
    throw new SkillLoadError(
      `${source}: frontmatter 'name' (${declaredName}) must match registration id (${registrationId})`,
    );
  }
  const name = declaredName ?? registrationId;
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
  if (s.length >= 2) {
    if (s.startsWith('"') && s.endsWith('"')) {
      // A double-quoted scalar is valid JSON, so JSON.parse decodes its escapes
      // (\" \\ \n \uXXXX) — the exact inverse of the JSON.stringify the UI server
      // writes with, so a description/tag containing quotes or backslashes
      // round-trips cleanly instead of accumulating escape characters. Fall back
      // to a bare strip when the body isn't valid JSON (e.g. an author wrote an
      // unescaped backslash), preserving the previous lenient behaviour.
      try {
        const parsed: unknown = JSON.parse(s);
        if (typeof parsed === "string") return parsed;
      } catch {
        // not valid JSON — fall through to the bare strip
      }
      return s.slice(1, -1);
    }
    if (s.startsWith("'") && s.endsWith("'")) {
      // Single-quoted YAML scalar: a doubled '' is an escaped literal quote.
      return s.slice(1, -1).replace(/''/g, "'");
    }
  }
  return s;
}

/**
 * Append an absolute-path index of bundled resources (a `scripts/` directory
 * and any sibling `*.md` reference files) so the agent can run or read them
 * once the body is in context. Returns the body unchanged when there are none.
 */
interface BundledResource {
  path: string;
  contents: string;
}

async function readBundledResources(
  skillDir: string,
): Promise<{ resources: BundledResource[]; watchInputs: string[] }> {
  const resourcePaths: string[] = [];
  const watchInputs: string[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(skillDir, { withFileTypes: true });
  } catch {
    return { resources: [], watchInputs };
  }

  for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
    if (entry.isDirectory() && entry.name === "scripts") {
      const scriptsDir = join(skillDir, "scripts");
      watchInputs.push(scriptsDir);
      try {
        const scripts = await readdir(scriptsDir, { withFileTypes: true });
        for (const script of scripts.sort((a, b) => compareText(a.name, b.name))) {
          if (script.isFile()) resourcePaths.push(join(scriptsDir, script.name));
        }
      } catch {
        // ignore an unreadable scripts dir
      }
    } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
      resourcePaths.push(join(skillDir, entry.name));
    }
  }

  const resources: Array<{ path: string; contents: string }> = [];
  for (const path of resourcePaths.sort()) {
    watchInputs.push(path);
    try {
      resources.push({ path, contents: await readFile(path, "utf8") });
    } catch {
      // Keep resource loading fail-soft, matching the enclosing legacy loader.
    }
  }
  return { resources, watchInputs };
}

function renderBundledResources(body: string, resources: BundledResource[]): string {
  if (resources.length === 0) return body;
  const list = resources.map((resource) => `- ${resource.path}`).join("\n");
  const contents = resources
    .map(
      (resource) => `### ${resource.path}\n\n${resource.contents.trimEnd() || "(empty resource)"}`,
    )
    .join("\n\n");
  return `${body}\n\n---\n\n## Bundled resources (absolute paths)\n\n${list}\n\n## Bundled resource contents\n\n${contents}\n`;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
