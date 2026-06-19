import {
  type AnalysisConfig,
  type ChatSource,
  createExtractor,
  type HierarchyEnv,
  HookChatSource,
  type IntentExtractor,
  type IntentsPaths,
  intentsPaths,
  type JsonFs,
  parseConfig,
  type RatelConfig,
  ratelConfigPath,
  resolveRatelDir,
} from "@ratel-ai/mcp-core";
import { resolveSkillDirs } from "../cli/skills/suggest.js";
import { createSkillMatcher } from "./matcher.js";
import type { SkillMatcher } from "./runner.js";

/** The fully-wired pieces a run needs, assembled from config + the `.ratel` home. */
export interface AnalysisRuntime {
  analysis?: AnalysisConfig;
  paths: IntentsPaths;
  chatSource: ChatSource;
  extractor: IntentExtractor;
  matchSkill: SkillMatcher;
  skillDirs: string[];
}

/**
 * Build the analysis runtime from the user's config + `RATEL_HOME`. Shared by
 * the `intents` CLI handler and the UI routes so the seam selection lives in one
 * place.
 */
export async function resolveAnalysisRuntime(
  env: HierarchyEnv,
  fs: JsonFs,
): Promise<AnalysisRuntime> {
  const analysis = await loadUserAnalysis(env, fs);
  const ratelDir = resolveRatelDir(process.env, env.homeDir);
  const paths = intentsPaths(ratelDir);
  const skillDirs = await resolveSkillDirs(env.homeDir);
  const coverage = analysis?.coverage ?? {};
  return {
    analysis,
    paths,
    chatSource: new HookChatSource({ chatDir: paths.chatDir, fs }),
    extractor: createExtractor(analysis),
    matchSkill: createSkillMatcher({
      dirs: skillDirs,
      minScore: coverage.minScore,
      relativeRatio: coverage.relativeRatio,
      limit: coverage.maxSkills,
    }),
    skillDirs,
  };
}

/** Read the `analysis` block from the user-scope Ratel config; undefined if absent/malformed. */
export async function loadUserAnalysis(
  env: HierarchyEnv,
  fs: JsonFs,
): Promise<AnalysisConfig | undefined> {
  const raw = await fs.read(ratelConfigPath("user", env));
  if (!raw) return undefined;
  try {
    const config: RatelConfig = parseConfig(JSON.parse(raw));
    return config.analysis;
  } catch {
    return undefined;
  }
}
