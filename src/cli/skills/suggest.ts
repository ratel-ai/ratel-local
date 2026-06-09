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
  /** True when the skill's declared stacks matched the project context. */
  stackMatch?: boolean;
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
  /** Score multiplier for skills whose `stacks` match the project (default 1.6). */
  stackBoost?: number;
  /**
   * When true (the push path), fire only on a *clear winner*: the top score must
   * beat the runner-up by `marginRatio`, else return nothing. Keeps the hook
   * quiet on vague prompts and ties (e.g. several skills matching a shared stack).
   */
  requireClearWinner?: boolean;
  /** Clear-winner margin (default 1.5×). */
  marginRatio?: number;
}

/** Injection seams for tests. */
export interface SuggestDeps {
  loadSkills?: (dirs: string[], opts: { logger?: (m: string) => void }) => Promise<Skill[]>;
  detectProjectSignals?: (cwd: string) => Promise<string[]>;
}

/**
 * Rank skills for a prompt with the push-path methodology:
 *
 *  1. Rank by the **prompt** against name + description + tags + **triggers**
 *     (triggers — author-declared task phrases — bridge a terse intent prompt to
 *     the skill). Project signals are *not* folded into the query.
 *  2. **Boost** skills whose declared `stacks` intersect the detected project
 *     context — so the stack biases *which* skill wins, while the prompt still
 *     selects. Context narrows; intent picks.
 *  3. Optional **clear-winner gate** ({@link SuggestInput.requireClearWinner}) so
 *     the push path stays silent unless there is an unambiguous best match.
 */
export async function suggestSkills(
  input: SuggestInput,
  deps: SuggestDeps = {},
): Promise<Suggestion[]> {
  const load = deps.loadSkills ?? loadSkills;
  const detect = deps.detectProjectSignals ?? detectProjectSignals;
  const limit = input.limit ?? 2;
  const minScore = input.minScore ?? 0;
  const stackBoost = input.stackBoost ?? 1.6;
  const marginRatio = input.marginRatio ?? 1.5;

  const prompt = input.prompt.trim();
  if (prompt.length === 0) return [];

  const skills = await load(input.dirs, {});
  if (skills.length === 0) return [];

  const catalog = new SkillCatalog();
  for (const s of skills) catalog.register(s);

  // Project context is a boost set, not a query term.
  const signals = input.cwd
    ? new Set((await detect(input.cwd)).map((t) => t.toLowerCase()))
    : new Set<string>();

  // Rank by the prompt; over-fetch so the stack boost can re-order.
  const raw = catalog.search(prompt, Math.max(limit * 4, 12), "agent");
  const ranked = raw
    .map((hit) => {
      const skill = catalog.get(hit.skillId);
      const stackMatch = (skill?.stacks ?? []).some((s) => signals.has(s.toLowerCase()));
      return {
        skillId: hit.skillId,
        description: skill?.description ?? "",
        score: hit.score * (stackMatch ? stackBoost : 1),
        stackMatch,
      };
    })
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return [];

  if (input.requireClearWinner) {
    const [top, second] = ranked;
    if (second && top.score < second.score * marginRatio) return [];
  }

  return ranked.slice(0, limit);
}

/**
 * Resolve which directories to rank skills from: the gateway's configured
 * `skills.dirs` (`~/.ratel/config.json`) if present, else the default
 * Ratel-managed folder. Keeps the hook aligned with what the gateway serves, so
 * a suggested skill id is loadable via `get_skill_content`.
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
