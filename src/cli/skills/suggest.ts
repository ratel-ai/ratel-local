import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Skill, SkillCatalog } from "@ratel-ai/sdk";
import { parseConfig } from "../../lib/config.js";
import { loadSkills } from "../../lib/skills/load.js";
import { detectProjectSignals } from "./signals.js";

export interface Suggestion {
  skillId: string;
  description: string;
  score: number;
}

export interface SuggestInput {
  prompt: string;
  cwd?: string;
  /** Directories to load skills from (resolve with {@link resolveSkillDirs}). */
  dirs: string[];
  /** Max suggestions (default 2). */
  limit?: number;
  /** Drop hits below this BM25 score (default 0 — keep all matches). */
  minScore?: number;
}

/** Injection seams for tests. */
export interface SuggestDeps {
  loadSkills?: (dirs: string[], opts: { logger?: (m: string) => void }) => Promise<Skill[]>;
  detectProjectSignals?: (cwd: string) => Promise<string[]>;
}

/**
 * Rank the skill catalog against the prompt augmented with project-stack signals
 * detected from `cwd`. Pure over its inputs; reuses `loadSkills` and the SDK's
 * BM25 `SkillCatalog`. Returns up to `limit` suggestions above `minScore`.
 */
export async function suggestSkills(
  input: SuggestInput,
  deps: SuggestDeps = {},
): Promise<Suggestion[]> {
  const load = deps.loadSkills ?? loadSkills;
  const detect = deps.detectProjectSignals ?? detectProjectSignals;
  const limit = input.limit ?? 2;
  const minScore = input.minScore ?? 0;

  const skills = await load(input.dirs, {});
  if (skills.length === 0) return [];

  const catalog = new SkillCatalog();
  for (const s of skills) catalog.register(s);

  const signals = input.cwd ? await detect(input.cwd) : [];
  const query = [input.prompt, ...signals].join(" ").trim();
  if (query.length === 0) return [];

  return catalog
    .search(query, limit, "agent")
    .filter((hit) => hit.score >= minScore)
    .map((hit) => ({
      skillId: hit.skillId,
      description: catalog.get(hit.skillId)?.description ?? "",
      score: hit.score,
    }));
}

/**
 * Resolve which directories to rank skills from: the gateway's configured
 * `skills.dirs` (`~/.ratel/config.json`) if present, else the default
 * Ratel-managed folder. Keeps the hook aligned with what the gateway serves, so
 * a suggested skill id is invokable via `invoke_skill`.
 */
export async function resolveSkillDirs(homeDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(homeDir, ".ratel", "config.json"), "utf8");
    const cfg = parseConfig(JSON.parse(raw));
    if (cfg.skills?.dirs && cfg.skills.dirs.length > 0) return cfg.skills.dirs;
  } catch {
    // missing or malformed config — fall back to the default folder
  }
  return [join(homeDir, ".ratel", "skills")];
}
