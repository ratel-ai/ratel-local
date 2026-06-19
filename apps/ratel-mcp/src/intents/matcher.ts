import { suggestSkills } from "../cli/skills/suggest.js";
import type { SkillMatcher } from "./runner.js";

/** Max skills reported as covering one intent. */
const DEFAULT_COVERAGE_LIMIT = 4;
/**
 * Absolute BM25 floor: below this, a skill is too weak to count as covering at
 * all. Set above the observed "noise floor" (~0.7, where a skill shares one
 * common term with an unrelated intent) but below genuine matches (which score
 * ~1.4+). Tunable.
 */
const DEFAULT_COVERAGE_MIN_SCORE = 1.0;
/**
 * Relative cutoff: keep only skills scoring within this fraction of the top
 * match. BM25 magnitudes vary a lot by query, so an absolute floor alone either
 * over- or under-reports; anchoring to the top match adapts per intent and trims
 * the tangential long tail (a strong top keeps only similarly-strong peers).
 */
const RELATIVE_RATIO = 0.6;

export interface SkillMatcherOptions {
  /** Skill directories to rank against (resolve with `resolveSkillDirs`). */
  dirs: string[];
  /** Max skills returned per intent (default 4). */
  limit?: number;
  /** Absolute BM25 floor below which a skill never counts as covering. */
  minScore?: number;
  /** Keep only skills within this fraction (0–1) of the top match (default 0.6). */
  relativeRatio?: number;
}

/**
 * Build a {@link SkillMatcher} backed by Ratel's skill-suggestion engine
 * (`SkillCatalog.search`, BM25) — the same index the gateway's capability search
 * uses. Returns the ranked list of skills covering an intent (best first):
 * matches above an absolute floor AND within {@link RELATIVE_RATIO} of the top
 * match. Empty list = a gap, which is what "Offer New Skills" keys off.
 */
export function createSkillMatcher(opts: SkillMatcherOptions): SkillMatcher {
  const floor = opts.minScore ?? DEFAULT_COVERAGE_MIN_SCORE;
  const limit = opts.limit ?? DEFAULT_COVERAGE_LIMIT;
  const ratio = opts.relativeRatio ?? RELATIVE_RATIO;
  return async (text, cwd) => {
    const hits = await suggestSkills({
      prompt: text,
      dirs: opts.dirs,
      cwd,
      limit: limit + 2,
      minScore: floor,
    });
    if (hits.length === 0) return [];
    const cutoff = Math.max(floor, hits[0].score * ratio);
    return hits
      .filter((h) => h.score >= cutoff)
      .slice(0, limit)
      .map((h) => ({ skillId: h.skillId, score: h.score }));
  };
}
