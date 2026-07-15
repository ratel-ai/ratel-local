import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkills, parseConfig } from "@ratel-ai/ratel-local-core";
import { type Skill, SkillCatalog } from "@ratel-ai/sdk";
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
  /**
   * Listing-path ordering boost for stack-matched skills (default 1.6×). Only
   * affects the order of returned suggestions; the clear-winner gate decides on
   * raw lexical scores, not this.
   */
  stackBoost?: number;
  /**
   * When true (the push path), fire only on a *clear winner* (see
   * {@link suggestSkills}): a clear lexical lead, or a lexical near-tie that
   * exactly one stack-matching skill breaks. Keeps the hook quiet on vague
   * prompts and genuine ties.
   */
  requireClearWinner?: boolean;
  /** Clear-winner / near-tie margin on raw scores (default 1.5×). */
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
 *  1. Rank by the **prompt** (lexical BM25) against name + description + tags
 *     (author **triggers** fold into tags on load: task phrases that bridge a
 *     terse intent prompt to the skill). Project signals are *not* folded into the query.
 *  2. The detected project **stack** is a tie-breaker, not an override: a clearly
 *     stronger lexical match always wins; the stack only decides among lexical
 *     near-ties. Context narrows; intent picks.
 *  3. Optional **clear-winner gate** ({@link SuggestInput.requireClearWinner}):
 *     fire only on an unambiguous winner (a clear lexical lead, or a near-tie that
 *     exactly one stack-matching skill breaks); stay silent otherwise.
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

  // Rank by the prompt; over-fetch so the stack can re-order among near-ties.
  const raw = catalog.search(prompt, Math.max(limit * 4, 12), "agent");
  const scored: Scored[] = raw
    .map((hit) => {
      const skill = catalog.get(hit.skillId);
      const stackMatch = (skill?.metadata?.stacks ?? []).some((s) => signals.has(s.toLowerCase()));
      return {
        skillId: hit.skillId,
        description: skill?.description ?? "",
        raw: hit.score,
        stackMatch,
      };
    })
    // Floor on the RAW lexical score: the stack boost biases ordering, it must
    // not smuggle a lexically-weak match past the relevance floor.
    .filter((h) => h.raw >= minScore);

  if (scored.length === 0) return [];

  if (input.requireClearWinner) {
    const winner = clearWinner(scored, marginRatio);
    return winner ? [toSuggestion(winner, stackBoost)] : [];
  }

  // Listing path (no gate): order by the stack-boosted score so project-relevant
  // skills surface first; deterministic tie-break by id.
  return [...scored]
    .sort((a, b) => boosted(b, stackBoost) - boosted(a, stackBoost) || cmp(a.skillId, b.skillId))
    .slice(0, limit)
    .map((h) => toSuggestion(h, stackBoost));
}

interface Scored {
  skillId: string;
  description: string;
  /** Raw BM25 (lexical) score — the prompt's match strength, pre-boost. */
  raw: number;
  stackMatch: boolean;
}

/**
 * Pick a single clear winner, or null if the result is ambiguous:
 *  - a clear LEXICAL winner (raw top beats the runner-up by `marginRatio`) wins
 *    outright — the project stack never overrides a clearly-stronger match;
 *  - otherwise, among the lexically near-tied contenders (raw within `marginRatio`
 *    of the top), the stack breaks the tie *only* if exactly one matches it;
 *  - zero or several stack matches in a near-tie → ambiguous → null (stay silent).
 */
function clearWinner(scored: Scored[], marginRatio: number): Scored | null {
  const byRaw = [...scored].sort((a, b) => b.raw - a.raw || cmp(a.skillId, b.skillId));
  const first = byRaw[0];
  if (!first) return null;
  const second = byRaw[1];
  if (!second) return first; // a single candidate is unambiguous
  if (first.raw >= second.raw * marginRatio) return first; // clear lexical winner
  const contenders = byRaw.filter((h) => h.raw >= first.raw / marginRatio);
  const stackMatched = contenders.filter((h) => h.stackMatch);
  return stackMatched.length === 1 ? stackMatched[0] : null;
}

function boosted(h: Scored, stackBoost: number): number {
  return h.raw * (h.stackMatch ? stackBoost : 1);
}

function toSuggestion(h: Scored, stackBoost: number): Suggestion {
  return {
    skillId: h.skillId,
    description: h.description,
    score: boosted(h, stackBoost),
    stackMatch: h.stackMatch,
  };
}

/** Deterministic, locale-independent string compare (for stable tie-breaks). */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
