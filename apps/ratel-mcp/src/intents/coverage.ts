import type { HierarchyEnv, IntentCoverage, JsonFs } from "@ratel-ai/mcp-core";
import { readIntentsIndex, writeIntentsIndex } from "@ratel-ai/mcp-core";
import { resolveAnalysisRuntime } from "./context.js";

/**
 * Re-evaluate every stored intent's coverage against the *current* managed
 * skills, without re-running the model. Cheap (BM25 only). Called whenever the
 * managed-skill set changes — activating/creating a skill can turn a gap into a
 * covered intent; deactivating/deleting one can turn a covered intent back into
 * a gap. Per-session `gapCount`s are recomputed to match.
 */
export async function recomputeIntentCoverage(env: HierarchyEnv, fs: JsonFs): Promise<void> {
  const runtime = await resolveAnalysisRuntime(env, fs);
  const index = await readIntentsIndex(fs, runtime.paths.intentsDir);
  if (index.intents.length === 0) return;

  const intents = await Promise.all(
    index.intents.map(async (intent) => {
      const matches = await runtime.matchSkill(intent.content);
      const coverage: IntentCoverage =
        matches.length > 0 ? { status: "covered", skills: matches } : { status: "gap" };
      return { ...intent, coverage };
    }),
  );

  const sessions = index.sessions.map((s) => ({
    ...s,
    gapCount: intents.filter((i) => i.sessions.includes(s.sessionId) && i.coverage.status === "gap")
      .length,
  }));

  await writeIntentsIndex(fs, runtime.paths.intentsDir, { ...index, intents, sessions });
}
