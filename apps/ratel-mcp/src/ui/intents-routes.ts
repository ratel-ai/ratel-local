import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type AnalysisConfig,
  createSkillGenerator,
  emptyIndex,
  HookChatSource,
  intentsPaths,
  loadSkills,
  normalizeIntentKey,
  type RunLogEntry,
  readAllSessionIntents,
  readChatState,
  readIntentsIndex,
  readRunLog,
  readSessionIntents,
  rebuildIndex,
  removeIntentFromSessions,
  resolveRatelDir,
  type SkillDraft,
  type SkillGenerator,
  sessionTurnsPath,
  writeChatState,
  writeIntentsIndex,
  writeSessionIntents,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "../cli/handlers/types.js";
import {
  type AnalysisRuntime,
  loadUserAnalysis,
  resolveAnalysisRuntime,
} from "../intents/context.js";
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
    runningSessionId: runState.sessionId,
    queuedSessionIds: runState.queue
      .map((q) => q.opts.sessionId)
      .filter((s): s is string => Boolean(s)),
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
interface RunRequest {
  ctx: HandlerCtx;
  opts: {
    sessionId?: string;
    everyNMessages?: number;
    onIdle?: boolean;
    all?: boolean;
    recentHours?: number;
    bypassCache?: boolean;
  };
  trigger: string;
}

const runState: {
  running: boolean;
  lastError: string | null;
  sessionId: string | null;
  queue: RunRequest[];
} = {
  running: false,
  lastError: null,
  // The session a per-chat run is processing (null for batch/all runs), so the UI
  // can keep showing a per-chat "analyzing" indicator even after navigating away.
  sessionId: null,
  // Pending runs: model inference is serial, so concurrent triggers queue here and
  // run one after another (clicking "Analyze" on several chats analyzes them all).
  queue: [],
};

/**
 * Start a fire-and-forget analysis run, honoring the module-level run guard and
 * the analysis master switch. Shared by the manual UI trigger and the scheduler
 * so the single-flight guard and error bookkeeping live in one place. Returns
 * immediately; callers watch `running`/`lastError` via GET /api/intents.
 *
 * On completion the run's per-session failures are summarized into
 * `runState.lastError` (cleared on a clean run); `runState.running` is always
 * reset in `finally`.
 */
export async function startAnalysisRun(
  ctx: HandlerCtx,
  opts: RunRequest["opts"],
  trigger: string,
): Promise<{ started: boolean; alreadyRunning?: boolean; disabled?: boolean; queued?: boolean }> {
  const analysis = await loadUserAnalysis(ctx.env, ctx.fs);
  if (analysis?.enabled === false) {
    return { started: false, disabled: true };
  }
  if (runState.running) {
    // A run is in flight; queue this one (inference is serial). Dedupe so the same
    // chat isn't queued twice, and a batch run doesn't pile up behind itself.
    const sid = opts.sessionId;
    const dup = sid
      ? runState.sessionId === sid || runState.queue.some((q) => q.opts.sessionId === sid)
      : runState.queue.some((q) => !q.opts.sessionId);
    if (!dup) runState.queue.push({ ctx, opts, trigger });
    return { started: false, queued: true };
  }
  launchAnalysis({ ctx, opts, trigger });
  return { started: true };
}

/**
 * Run one request now, then drain the queue. Sets the in-flight state, runs the
 * analysis, and on completion starts the next queued request (if any) so chained
 * per-chat analyses run sequentially.
 */
function launchAnalysis(req: RunRequest): void {
  runState.running = true;
  runState.lastError = null;
  runState.sessionId = req.opts.sessionId ?? null;
  void (async () => {
    try {
      const runtime = await resolveAnalysisRuntime(req.ctx.env, req.ctx.fs);
      if (runtime.analysis?.enabled !== false) {
        const result = await runAnalysis(
          {
            fs: req.ctx.fs,
            intentsDir: runtime.paths.intentsDir,
            chatSource: runtime.chatSource,
            extractor: runtime.extractor,
            matchSkill: runtime.matchSkill,
            extractorModel: runtime.analysis?.extractor?.model,
            now: () => new Date().toISOString(),
            log: req.ctx.log,
          },
          // Recency window comes from config unless the caller set one; ignored for
          // the explicit sessionId/all paths inside the runner.
          {
            recentHours: runtime.analysis?.cadence?.recentHours,
            ...req.opts,
            trigger: req.trigger,
          },
        );
        runState.lastError = summarizeRunErrors(result.errors);
        if (runState.lastError)
          req.ctx.log(`[ratel] analysis completed with errors: ${runState.lastError}`);
      }
    } catch (err) {
      runState.lastError = err instanceof Error ? err.message : String(err);
      req.ctx.log(`[ratel] analysis failed: ${runState.lastError}`);
    } finally {
      runState.running = false;
      runState.sessionId = null;
      const next = runState.queue.shift();
      if (next) launchAnalysis(next);
    }
  })();
}

/** Build a concise one-line summary of a run's per-session failures, or null when clean. */
function summarizeRunErrors(errors: Array<{ sessionId: string; message: string }>): string | null {
  if (errors.length === 0) return null;
  return `${errors.length} session(s) failed: ${errors[0].message}`;
}

/**
 * POST /api/intents/run — manual trigger. With `sessionId`, analyzes just that
 * chat (always, ignoring due-checks). With `all: true`, re-analyzes every chat
 * (ignores the new-activity/recency filters). Otherwise analyzes only chats with
 * new activity since their last analysis (skips up-to-date chats so it doesn't
 * needlessly re-run the model). Returns immediately; watch `running` via GET /api/intents.
 */
export async function runIntentsRoute(
  ctx: HandlerCtx,
  body: { sessionId?: unknown; all?: unknown },
): Promise<ApiResponse> {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const all = body.all === true;
  // "Re-analyze all" forces fresh extraction (bypass cache); the incremental and
  // per-chat paths keep using the cache for speed.
  const opts = sessionId
    ? { sessionId }
    : all
      ? { all: true, bypassCache: true }
      : { everyNMessages: 1, onIdle: true };
  const trigger = sessionId ? "session" : all ? "all" : "manual";
  const result = await startAnalysisRun(ctx, opts, trigger);
  return ok(result);
}

/**
 * POST /api/intents/delete — remove a single intent (by content) durably. Strips
 * it from the per-session files (not just the index) so the next rebuild can't
 * resurrect it, then rebuilds the index from the surviving session files.
 */
export async function deleteIntentRoute(
  ctx: HandlerCtx,
  body: { content?: unknown },
): Promise<ApiResponse> {
  const content = typeof body.content === "string" ? body.content : "";
  if (content.trim().length === 0) {
    throw new Error("content is required");
  }
  const dir = intentsDirFor(ctx);
  const sessions = await readAllSessionIntents(ctx.fs, dir);
  const updated = removeIntentFromSessions(sessions, content);
  // Persist only the sessions whose intents actually changed.
  for (let i = 0; i < sessions.length; i++) {
    if (sessions[i].intents.length !== updated[i].intents.length) {
      await writeSessionIntents(ctx.fs, dir, updated[i]);
    }
  }
  const next = rebuildIndex(updated);
  await writeIntentsIndex(ctx.fs, dir, next);
  return ok({ removed: content, remaining: next.intents.length });
}

/**
 * POST /api/intents/clear — wipe all analysis output durably: delete every
 * per-session file, drop the extraction cache (so the next run re-runs the model
 * instead of replaying cached results), and reset the index to empty.
 */
export async function clearIntentsRoute(ctx: HandlerCtx): Promise<ApiResponse> {
  const dir = intentsDirFor(ctx);
  const sessions = await readAllSessionIntents(ctx.fs, dir);
  for (const session of sessions) {
    await rm(join(dir, "sessions", `${session.sessionId}.json`), { force: true });
  }
  // Drop the extraction cache too — otherwise a re-analysis replays the cached
  // extractions and the cleared intents look like they "came back from cache".
  await rm(join(dir, "cache"), { recursive: true, force: true });
  await writeIntentsIndex(ctx.fs, dir, emptyIndex());
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
 * A background skill-generation job. Generation can shell out to `claude -p` or
 * call the Anthropic API, both of which take a while, so it runs fire-and-forget
 * and the UI polls {@link offerStatusRoute} for the draft.
 */
export interface OfferJob {
  status: "running" | "done" | "error";
  intent: string;
  /** Human label of the model the draft is/was generated with. */
  model: string;
  /** ISO timestamp when the job started. */
  startedAt: string;
  draft?: SkillDraft;
  error?: string;
}

/** In-flight + completed offer jobs, keyed by {@link normalizeIntentKey} of the intent. */
const offerJobs = new Map<string, OfferJob>();

/** Resolve a human label for the skill-gen model, mirroring createSkillGenerator's selection. */
function resolveSkillGenModelLabel(analysis: AnalysisConfig | undefined): string {
  const skillGen = analysis?.skillGen ?? {};
  if (skillGen.model) return skillGen.model;
  const provider = skillGen.provider ?? "auto";
  const useApi = provider === "anthropic-api" || (provider === "auto" && Boolean(skillGen.apiKey));
  return useApi ? "claude-sonnet-4-6" : "haiku";
}

/**
 * Build a rich generation context for an intent: the existing skill ids (so the
 * draft avoids duplicates), the intent's own evidence snippets, and the other
 * intents seen in the same sessions — all gathered from the durable per-session
 * files. Both evidence and related-intent lists are de-duped and capped.
 */
async function buildOfferContext(
  ctx: HandlerCtx,
  runtime: AnalysisRuntime,
  intent: string,
): Promise<{
  existingSkillIds: string[];
  evidences: string[];
  relatedIntents: string[];
  cwd?: string;
}> {
  const key = normalizeIntentKey(intent);
  const index = await readIntentsIndex(ctx.fs, runtime.paths.intentsDir);
  const record = index.intents.find((i) => normalizeIntentKey(i.content) === key);
  const sessionIds = record?.sessions ?? [];

  const evidences = new Set<string>();
  const relatedIntents = new Set<string>();
  let cwd: string | undefined;
  for (const sessionId of sessionIds) {
    const session = await readSessionIntents(ctx.fs, runtime.paths.intentsDir, sessionId);
    if (!session) continue;
    if (!cwd && session.cwd) cwd = session.cwd;
    for (const i of session.intents) {
      if (normalizeIntentKey(i.content) === key) {
        for (const e of i.evidences ?? []) evidences.add(e);
      } else {
        relatedIntents.add(i.content);
      }
    }
  }

  const skills = await loadSkills(runtime.skillDirs, {});
  return {
    existingSkillIds: skills.map((s) => s.id),
    evidences: [...evidences].slice(0, 12),
    relatedIntents: [...relatedIntents].slice(0, 12),
    cwd,
  };
}

/**
 * POST /api/skills/offer — start drafting a skill for an uncovered intent in the
 * background. Idempotent while running: a second call for the same intent returns
 * `{ started:false, alreadyRunning:true }`. The draft is fetched via
 * {@link offerStatusRoute}; the UI persists an accepted draft through the
 * existing `POST /api/skills`.
 *
 * `deps.generator` is an injection seam for tests; in production the generator is
 * built from config via `createSkillGenerator`.
 */
export async function offerSkillRoute(
  ctx: HandlerCtx,
  body: { intent?: unknown },
  deps: { generator?: SkillGenerator } = {},
): Promise<ApiResponse> {
  const intent = typeof body.intent === "string" ? body.intent.trim() : "";
  if (intent.length === 0) {
    throw new Error("intent is required");
  }
  const runtime = await resolveAnalysisRuntime(ctx.env, ctx.fs);
  const model = resolveSkillGenModelLabel(runtime.analysis);
  const key = normalizeIntentKey(intent);

  const existing = offerJobs.get(key);
  if (existing?.status === "running") {
    return ok({ started: false, alreadyRunning: true, intent, model });
  }

  const job: OfferJob = {
    status: "running",
    intent,
    model,
    startedAt: new Date().toISOString(),
  };
  offerJobs.set(key, job);

  const generator = deps.generator ?? createSkillGenerator(runtime.analysis);
  void (async () => {
    try {
      const context = await buildOfferContext(ctx, runtime, intent);
      const draft = await generator.generate({ content: intent }, context);
      offerJobs.set(key, { ...job, status: "done", draft });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      offerJobs.set(key, { ...job, status: "error", error: message });
      ctx.log(`[ratel] skill offer failed for "${intent}": ${message}`);
    }
  })();

  return ok({ started: true, intent, model });
}

/**
 * GET /api/skills/offer/status?intent=… — poll a background skill-gen job. Reports
 * `idle` when no job exists for the intent, else its current status with the draft
 * (when done) or error message (when failed).
 */
export async function offerStatusRoute(_ctx: HandlerCtx, intent: string): Promise<ApiResponse> {
  const key = normalizeIntentKey(typeof intent === "string" ? intent : "");
  const job = offerJobs.get(key);
  if (!job) {
    return ok({ status: "idle" });
  }
  return ok({
    status: job.status,
    draft: job.draft,
    error: job.error,
    model: job.model,
    startedAt: job.startedAt,
  });
}

/**
 * GET /api/skills/offer/jobs — summarize every background skill-gen job (running,
 * done, or failed) so a returning user can find a draft they started earlier. The
 * draft body is deliberately omitted to keep the payload small; the client fetches
 * it via {@link offerStatusRoute} when opening the review.
 */
export async function listOfferJobsRoute(_ctx: HandlerCtx): Promise<ApiResponse> {
  const jobs = [...offerJobs.values()].map((job) => ({
    intent: job.intent,
    status: job.status,
    model: job.model,
    startedAt: job.startedAt,
    error: job.error,
    hasDraft: Boolean(job.draft),
  }));
  return ok({ jobs });
}

/**
 * DELETE /api/skills/offer?intent=… — drop a finished/declined authoring job from
 * the registry so it stops surfacing as "Skill ready". Called after a draft is
 * created (the skill now exists) or explicitly declined. Idempotent.
 */
export async function clearOfferJobRoute(_ctx: HandlerCtx, intent: string): Promise<ApiResponse> {
  const key = normalizeIntentKey(typeof intent === "string" ? intent : "");
  const removed = offerJobs.delete(key);
  return ok({ cleared: removed });
}

/**
 * GET /api/observability — recent analysis runs plus a small rollup summary, for
 * the observability view. Tolerates an empty log (zeroed summary).
 */
export async function getObservabilityRoute(ctx: HandlerCtx): Promise<ApiResponse> {
  const { intentsDir } = intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir));
  const runs = await readRunLog(ctx.fs, intentsDir, 50);
  return ok({ runs, summary: summarizeRuns(runs) });
}

/** Roll a run list up into headline metrics; returns zeroed fields for an empty list. */
function summarizeRuns(runs: RunLogEntry[]): {
  totalRuns: number;
  lastRunAt: string | null;
  avgDurationMs: number;
  avgGapsPerRun: number;
} {
  if (runs.length === 0) {
    return { totalRuns: 0, lastRunAt: null, avgDurationMs: 0, avgGapsPerRun: 0 };
  }
  const totalDuration = runs.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const totalGaps = runs.reduce((sum, r) => sum + (r.totalGaps ?? 0), 0);
  // readRunLog returns newest-first, so the first entry is the most recent run.
  return {
    totalRuns: runs.length,
    lastRunAt: runs[0].at ?? null,
    avgDurationMs: Math.round(totalDuration / runs.length),
    avgGapsPerRun: Math.round((totalGaps / runs.length) * 10) / 10,
  };
}

/** One chat/session row for the Chats page. */
export interface ChatSummary {
  sessionId: string;
  host: string;
  cwd?: string;
  title: string;
  turnCount: number;
  updatedAt?: string;
  lastAnalyzedAt?: string;
  idle: boolean;
  intentCount: number;
  gapCount: number;
  /** True when a session summary exists in the intents index (i.e. it was analyzed). */
  analyzed: boolean;
}

/** Collapse whitespace and truncate a turn into a short title (~80 chars). */
function deriveTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) return collapsed;
  return `${collapsed.slice(0, 80)}…`;
}

/**
 * GET /api/chats — every captured session with a derived title and intent/gap
 * counts, sorted by most-recently-updated. Resilient: a session whose turns are
 * unreadable still lists (the title falls back to its cwd basename / id).
 */
export async function getChatsRoute(ctx: HandlerCtx): Promise<ApiResponse> {
  const { intentsDir, chatDir } = intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir));
  const state = await readChatState(ctx.fs, chatDir);
  const index = await readIntentsIndex(ctx.fs, intentsDir);
  const source = new HookChatSource({ chatDir, fs: ctx.fs });
  const summaryById = new Map(index.sessions.map((s) => [s.sessionId, s]));

  const chats: ChatSummary[] = [];
  for (const meta of Object.values(state.sessions)) {
    const turns = await source.readSession(meta.sessionId);
    const firstUser = turns.find((t) => t.role === "user");
    const fallback = meta.cwd ? basename(meta.cwd) : meta.sessionId;
    const title = firstUser ? deriveTitle(firstUser.content) : fallback;
    const summary = summaryById.get(meta.sessionId);
    chats.push({
      sessionId: meta.sessionId,
      host: meta.host,
      cwd: meta.cwd,
      title,
      turnCount: turns.length,
      updatedAt: meta.updatedAt,
      lastAnalyzedAt: meta.lastAnalyzedAt,
      idle: meta.idle === true,
      intentCount: summary?.intentCount ?? 0,
      gapCount: summary?.gapCount ?? 0,
      analyzed: summary !== undefined,
    });
  }

  chats.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return ok({ chats });
}

/** Default number of recent turns returned per chat request. */
const DEFAULT_CHAT_TURNS = 60;
/** Upper bound on the per-request turn window, so a huge limit can't bloat the response. */
const MAX_CHAT_TURNS = 2000;

/** Clamp a requested turn limit to a sane window, falling back to the default on bad input. */
function resolveChatLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit) || limit <= 0) {
    return DEFAULT_CHAT_TURNS;
  }
  return Math.min(Math.floor(limit), MAX_CHAT_TURNS);
}

/**
 * GET /api/chats/:sessionId — one session's metadata plus a recent slice of its
 * transcript: the last `limit` turns (default 60, clamped to a sane max), with
 * `total` carrying the full turn count so the UI can offer "load earlier".
 * 404 when the session is unknown or has no readable turns.
 */
export async function getChatRoute(
  ctx: HandlerCtx,
  sessionId: string,
  limit?: number,
): Promise<ApiResponse> {
  const { chatDir } = intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir));
  const state = await readChatState(ctx.fs, chatDir);
  const meta = state.sessions[sessionId];
  const source = new HookChatSource({ chatDir, fs: ctx.fs });
  const turns = await source.readSession(sessionId);
  if (!meta && turns.length === 0) {
    return { status: 404, body: { error: `unknown session: ${sessionId}`, isError: true } };
  }
  const firstUser = turns.find((t) => t.role === "user");
  const fallback = meta?.cwd ? basename(meta.cwd) : sessionId;
  return ok({
    sessionId,
    host: meta?.host,
    cwd: meta?.cwd,
    title: firstUser ? deriveTitle(firstUser.content) : fallback,
    turns: turns.slice(-resolveChatLimit(limit)),
    total: turns.length,
  });
}

/**
 * DELETE /api/chats/:sessionId — durably delete a session: its captured turn
 * file, its chat-state entry, and its per-session intents file, then rebuild the
 * index from the survivors so the deletion sticks. Already-missing files are
 * tolerated.
 */
export async function deleteChatRoute(ctx: HandlerCtx, sessionId: string): Promise<ApiResponse> {
  const { intentsDir, chatDir } = intentsPaths(resolveRatelDir(process.env, ctx.env.homeDir));
  const state = await readChatState(ctx.fs, chatDir);
  const meta = state.sessions[sessionId];

  // Remove the captured turn file (try the known host, else all candidates).
  const hosts = meta?.host ? [meta.host] : ["claude-code", "codex", "unknown"];
  for (const host of hosts) {
    await rm(sessionTurnsPath(chatDir, host, sessionId), { force: true });
  }

  // Drop the session entry from chat state.
  if (meta) {
    const { [sessionId]: _removed, ...rest } = state.sessions;
    await writeChatState(ctx.fs, chatDir, { ...state, sessions: rest });
  }

  // Remove its per-session intents file, then rebuild the index from survivors.
  await rm(join(intentsDir, "sessions", `${sessionId}.json`), { force: true });
  const sessions = await readAllSessionIntents(ctx.fs, intentsDir);
  await writeIntentsIndex(ctx.fs, intentsDir, rebuildIndex(sessions));

  return ok({ deleted: sessionId });
}
