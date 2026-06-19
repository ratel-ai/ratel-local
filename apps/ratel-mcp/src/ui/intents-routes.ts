import {
  type AnalysisConfig,
  createSkillGenerator,
  emptyIndex,
  intentsPaths,
  loadSkills,
  readChatState,
  readIntentsIndex,
  readSessionIntents,
  removeIntent,
  resolveRatelDir,
  writeIntentsIndex,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { loadUserAnalysis, resolveAnalysisRuntime } from "../intents/context.js";
import { recomputeIntentCoverage } from "../intents/coverage.js";
import { DEFAULT_EVERY_N_MESSAGES, runAnalysis } from "../intents/runner.js";
import { readAnalysisSettings, SECRET_MASK, writeAnalysisSettings } from "./analysis-settings.js";
import type { ApiResponse } from "./routes.js";

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function intentsDirFor(ctx: HandlerCtx): string {
  return intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir)).intentsDir;
}

/**
 * GET /api/intents — the cumulative index, enriched with the cadence threshold
 * and each session's new-message count since its last analysis, so the UI can
 * show how many more messages until the next automatic run.
 */
export async function getIntents(ctx: HandlerCtx): Promise<ApiResponse> {
  const { intentsDir, chatDir } = intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir));
  const index = await readIntentsIndex(ctx.fs, intentsDir);
  const state = await readChatState(ctx.fs, chatDir);
  const analysis = await loadUserAnalysis(ctx.env, ctx.fs);
  const cadence = {
    everyNMessages: analysis?.cadence?.everyNMessages ?? DEFAULT_EVERY_N_MESSAGES,
    onIdle: analysis?.cadence?.onIdle ?? false,
  };
  const sessions = index.sessions.map((s) => ({
    ...s,
    newTurnCount: state.sessions[s.sessionId]?.newTurnCount ?? 0,
  }));
  return ok({
    ...index,
    sessions,
    cadence,
    // On unless explicitly disabled (the feature predates this flag).
    enabled: analysis?.enabled !== false,
    running: runState.running,
    lastError: runState.lastError,
  });
}

/** GET /api/intents/:sessionId — the full per-session result (claims + annotated intents). */
export async function getSessionIntents(ctx: HandlerCtx, sessionId: string): Promise<ApiResponse> {
  const session = await readSessionIntents(ctx.fs, intentsDirFor(ctx), sessionId);
  if (!session) {
    return { status: 404, body: { error: `no intents for session: ${sessionId}`, isError: true } };
  }
  return ok(session);
}

/**
 * In-flight analysis status. Model inference can take a while, so the run is
 * fire-and-forget: the request returns immediately and the UI polls getIntents
 * for `running`, instead of blocking on a request that could hang on a slow or
 * crashed sidecar.
 */
const runState: { running: boolean; lastError: string | null } = {
  running: false,
  lastError: null,
};

/**
 * POST /api/intents/run — manual trigger. Analyzes one session when `sessionId`
 * is given, otherwise every session with new activity since its last analysis
 * (skips up-to-date sessions, so it doesn't needlessly re-run the model). Returns
 * immediately; watch `running` from GET /api/intents.
 */
export async function runIntentsRoute(
  ctx: HandlerCtx,
  body: { sessionId?: unknown },
): Promise<ApiResponse> {
  if (runState.running) {
    return ok({ started: false, alreadyRunning: true });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const runtime = await resolveAnalysisRuntime(ctx.env, ctx.fs);
  if (runtime.analysis?.enabled === false) {
    return ok({ started: false, disabled: true });
  }
  runState.running = true;
  runState.lastError = null;
  void (async () => {
    try {
      await runAnalysis(
        {
          fs: ctx.fs,
          intentsDir: runtime.paths.intentsDir,
          chatSource: runtime.chatSource,
          extractor: runtime.extractor,
          matchSkill: runtime.matchSkill,
          now: () => new Date().toISOString(),
          log: ctx.log,
        },
        sessionId ? { sessionId } : { everyNMessages: 1, onIdle: true },
      );
    } catch (err) {
      runState.lastError = err instanceof Error ? err.message : String(err);
      ctx.log(`[ratel] analysis failed: ${runState.lastError}`);
    } finally {
      runState.running = false;
    }
  })();
  return ok({ started: true });
}

/** POST /api/intents/delete — remove a single intent (by content) from the index. */
export async function deleteIntentRoute(
  ctx: HandlerCtx,
  body: { content?: unknown },
): Promise<ApiResponse> {
  const content = typeof body.content === "string" ? body.content : "";
  if (content.trim().length === 0) {
    throw new Error("content is required");
  }
  const dir = intentsDirFor(ctx);
  const next = removeIntent(await readIntentsIndex(ctx.fs, dir), content);
  await writeIntentsIndex(ctx.fs, dir, next);
  return ok({ removed: content, remaining: next.intents.length });
}

/** POST /api/intents/clear — wipe the cumulative index (intents are regenerated on the next run). */
export async function clearIntentsRoute(ctx: HandlerCtx): Promise<ApiResponse> {
  await writeIntentsIndex(ctx.fs, intentsDirFor(ctx), emptyIndex());
  return ok({ cleared: true });
}

/** GET /api/analysis/settings — masked settings + the sentinel the UI echoes for unchanged secrets. */
export async function getAnalysisSettings(ctx: HandlerCtx): Promise<ApiResponse> {
  return ok({ analysis: await readAnalysisSettings(ctx.env, ctx.fs), secretMask: SECRET_MASK });
}

/** PUT /api/analysis/settings — validate + persist the analysis block (throws → 400). */
export async function putAnalysisSettings(
  ctx: HandlerCtx,
  body: Record<string, unknown>,
): Promise<ApiResponse> {
  const incoming = (body.analysis ?? body) as AnalysisConfig;
  const saved = await writeAnalysisSettings(ctx.env, ctx.fs, incoming);
  // Coverage thresholds may have changed — re-evaluate so the change shows now.
  await recomputeIntentCoverage(ctx.env, ctx.fs).catch(() => undefined);
  return ok({ analysis: saved, secretMask: SECRET_MASK });
}

/**
 * POST /api/skills/offer — draft a skill for an uncovered intent via the
 * configured generator (anthropic-api or `claude -p`). The draft is returned for
 * review only; the UI persists it through the existing `POST /api/skills`.
 */
export async function offerSkillRoute(
  ctx: HandlerCtx,
  body: { intent?: unknown },
): Promise<ApiResponse> {
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (intent.length === 0) {
    throw new Error("intent is required");
  }
  const runtime = await resolveAnalysisRuntime(ctx.env, ctx.fs);
  const skills = await loadSkills(runtime.skillDirs, {});
  const generator = createSkillGenerator(runtime.analysis);
  const draft = await generator.generate(
    { content: intent },
    { existingSkillIds: skills.map((s) => s.id) },
  );
  return ok({ draft });
}
