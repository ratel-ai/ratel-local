import { randomUUID } from "node:crypto";
import {
  appendRunLog,
  type ChatSessionMeta,
  type ChatSource,
  type ChatTurn,
  type IntentCoverage,
  type IntentExtractor,
  type JsonFs,
  type RunLogEntry,
  type RunLogSessionEntry,
  readAllSessionIntents,
  rebuildIndex,
  type SessionIntents,
  type StoredIntent,
  writeIntentsIndex,
  writeSessionIntents,
} from "@ratel-ai/mcp-core";
import { cacheKey, createFsExtractionCache, type ExtractionCache } from "./extraction-cache.js";

/** Default every-N-messages threshold when the config omits one. */
export const DEFAULT_EVERY_N_MESSAGES = 10;

/** Default trigger label recorded in run telemetry when callers omit one. */
const DEFAULT_TRIGGER = "manual";

export interface SkillMatch {
  skillId: string;
  score: number;
}

/** Resolve which managed skills cover an intent (BM25-ranked, best first; empty = a gap). */
export type SkillMatcher = (intentText: string, cwd?: string) => Promise<SkillMatch[]>;

export interface AnalysisRunnerDeps {
  fs: JsonFs;
  intentsDir: string;
  chatSource: ChatSource;
  extractor: IntentExtractor;
  matchSkill: SkillMatcher;
  /** ISO-timestamp provider (injected so runs are deterministic in tests). */
  now: () => string;
  /** Model id of the configured extractor; folded into the cache key so a model change invalidates it. */
  extractorModel?: string;
  /** Extraction cache; defaults to a filesystem cache under `<intentsDir>/cache/`. */
  cache?: ExtractionCache;
  /** Monotonic millisecond clock for per-session latency (injected for deterministic tests). */
  monotonic?: () => number;
  log?: (message: string) => void;
}

export interface RunAnalysisOptions {
  /** Analyze only this session (the manual/idle-hook path). */
  sessionId?: string;
  /** Analyze every session that has captured turns (manual "run all"). */
  all?: boolean;
  /** Threshold trigger: analyze sessions with at least this many new turns. */
  everyNMessages?: number;
  /** Also analyze sessions the capture layer flagged idle. */
  onIdle?: boolean;
  /**
   * Limit the threshold/idle batch to sessions active within this many hours.
   * Ignored when `sessionId` or `all` is set (those are explicit). Omitted = no limit.
   */
  recentHours?: number;
  /** Force fresh extraction, ignoring (but still refreshing) the extraction cache. */
  bypassCache?: boolean;
  /** Telemetry label for this run (e.g. "manual" | "idle" | "cadence" | "all" | "session"). */
  trigger?: string;
}

export interface RunAnalysisResult {
  analyzed: string[];
  skipped: string[];
  intentsFound: number;
  gaps: number;
  /** Sessions whose analysis threw; the batch continues past each failure. */
  errors: Array<{ sessionId: string; message: string }>;
}

/** Internal per-session outcome, used to build both the result and the run log. */
interface SessionOutcome {
  entry: RunLogSessionEntry;
  intents: number;
  gaps: number;
  ok: boolean;
}

/**
 * The single unit every trigger (manual button/CLI, idle Stop hook, every-N
 * threshold) calls. Selects the due sessions, extracts intents via the
 * configured {@link IntentExtractor} (reusing cached extractions when the turns
 * and model are unchanged), annotates each with skill coverage, persists the
 * per-session result, rebuilds the cumulative index from disk so partial
 * progress is durable, and marks the session analyzed so its new-turn counter
 * resets. One failing session never aborts the batch — its error is recorded and
 * the run continues. A single {@link RunLogEntry} is appended for the whole run.
 */
export async function runAnalysis(
  deps: AnalysisRunnerDeps,
  opts: RunAnalysisOptions = {},
): Promise<RunAnalysisResult> {
  const everyN = opts.everyNMessages ?? DEFAULT_EVERY_N_MESSAGES;
  const trigger = opts.trigger ?? DEFAULT_TRIGGER;
  const cache = deps.cache ?? createFsExtractionCache(deps.fs, deps.intentsDir);
  const monotonic = deps.monotonic ?? (() => Date.now());

  const sessions = await deps.chatSource.listSessions();
  const due = applyRecencyWindow(selectDueSessions(sessions, opts, everyN), opts, deps.now);

  const result: RunAnalysisResult = {
    analyzed: [],
    skipped: [],
    intentsFound: 0,
    gaps: 0,
    errors: [],
  };
  const logEntries: RunLogSessionEntry[] = [];
  const runStarted = monotonic();

  for (const meta of due) {
    const turns = await deps.chatSource.readSession(meta.sessionId);
    if (turns.length === 0) {
      result.skipped.push(meta.sessionId);
      continue;
    }

    const outcome = await analyzeSession(deps, cache, monotonic, meta, turns, opts.bypassCache);
    logEntries.push(outcome.entry);

    if (outcome.ok) {
      result.analyzed.push(meta.sessionId);
      result.intentsFound += outcome.intents;
      result.gaps += outcome.gaps;
    } else if (outcome.entry.error) {
      result.errors.push({ sessionId: meta.sessionId, message: outcome.entry.error });
    }
  }

  await appendRunEntry(deps, {
    runId: randomUUID(),
    at: deps.now(),
    trigger,
    model: deps.extractorModel,
    durationMs: monotonic() - runStarted,
    totalIntents: result.intentsFound,
    totalGaps: result.gaps,
    sessions: logEntries,
  });

  return result;
}

/**
 * Analyze one session end-to-end (extract → match → persist → rebuild index →
 * mark analyzed), wrapped so a failure is captured rather than thrown. Returns
 * the per-session telemetry entry plus the counts the caller folds into totals.
 */
async function analyzeSession(
  deps: AnalysisRunnerDeps,
  cache: ExtractionCache,
  monotonic: () => number,
  meta: ChatSessionMeta,
  turns: ChatTurn[],
  bypassCache = false,
): Promise<SessionOutcome> {
  const started = monotonic();
  let cacheHit = false;
  try {
    const key = cacheKey(turns, deps.extractorModel);
    let extraction = bypassCache ? null : await cache.get(key);
    if (extraction) {
      cacheHit = true;
    } else {
      extraction = await deps.extractor.extract(turns);
      await cache.set(key, extraction);
    }

    const storedIntents = await annotateIntents(deps, extraction.intents, meta.cwd);
    const now = deps.now();
    const session: SessionIntents = {
      sessionId: meta.sessionId,
      host: meta.host,
      cwd: meta.cwd,
      analyzedAt: now,
      claims: extraction.claims,
      intents: storedIntents,
    };

    await writeSessionIntents(deps.fs, deps.intentsDir, session);
    await rebuildDurableIndex(deps);
    await deps.chatSource.markAnalyzed?.(meta.sessionId, now);

    const gaps = storedIntents.filter((i) => i.coverage.status === "gap").length;
    deps.log?.(`[ratel] analyzed ${meta.sessionId}: ${storedIntents.length} intents, ${gaps} gaps`);

    return {
      ok: true,
      intents: storedIntents.length,
      gaps,
      entry: {
        sessionId: meta.sessionId,
        host: meta.host,
        ok: true,
        intents: storedIntents.length,
        gaps,
        turns: turns.length,
        latencyMs: monotonic() - started,
        cacheHit,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`[ratel] analysis failed for ${meta.sessionId}: ${message}`);
    return {
      ok: false,
      intents: 0,
      gaps: 0,
      entry: {
        sessionId: meta.sessionId,
        host: meta.host,
        ok: false,
        error: message,
        intents: 0,
        gaps: 0,
        turns: turns.length,
        latencyMs: monotonic() - started,
        cacheHit,
      },
    };
  }
}

/** Annotate each extracted intent with managed-skill coverage. */
async function annotateIntents(
  deps: AnalysisRunnerDeps,
  intents: Array<{ content: string; evidences?: string[] }>,
  cwd?: string,
): Promise<StoredIntent[]> {
  const stored: StoredIntent[] = [];
  for (const intent of intents) {
    const matches = await deps.matchSkill(intent.content, cwd);
    const coverage: IntentCoverage =
      matches.length > 0 ? { status: "covered", skills: matches } : { status: "gap" };
    const entry: StoredIntent = { content: intent.content, coverage };
    if (intent.evidences) entry.evidences = intent.evidences;
    stored.push(entry);
  }
  return stored;
}

/**
 * Rebuild the whole index from the per-session files on disk and persist it.
 * Derive-from-source (instead of read-modify-write) means partial progress is
 * always visible and the index can never drift from the session files.
 */
async function rebuildDurableIndex(deps: AnalysisRunnerDeps): Promise<void> {
  const sessions = await readAllSessionIntents(deps.fs, deps.intentsDir);
  await writeIntentsIndex(deps.fs, deps.intentsDir, rebuildIndex(sessions));
}

/** Append the run telemetry entry; telemetry failures must never break a run. */
async function appendRunEntry(deps: AnalysisRunnerDeps, entry: RunLogEntry): Promise<void> {
  try {
    await appendRunLog(deps.fs, deps.intentsDir, entry);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`[ratel] failed to record run telemetry: ${message}`);
  }
}

/** Pick the sessions a run should process for the given trigger. */
export function selectDueSessions(
  sessions: ChatSessionMeta[],
  opts: RunAnalysisOptions,
  everyN: number,
): ChatSessionMeta[] {
  if (opts.sessionId) {
    return sessions.filter((s) => s.sessionId === opts.sessionId);
  }
  if (opts.all) {
    return sessions;
  }
  return sessions.filter(
    (s) =>
      s.newTurnCount >= everyN ||
      s.needsReanalysis === true ||
      (Boolean(opts.onIdle) && s.idle === true),
  );
}

/**
 * Drop sessions not active within `opts.recentHours` so a bulk run doesn't churn
 * through every old chat. Skipped when `recentHours` is unset, or for the explicit
 * `sessionId`/`all` paths. A session with no `updatedAt` is kept (can't judge it).
 */
export function applyRecencyWindow(
  due: ChatSessionMeta[],
  opts: RunAnalysisOptions,
  now: () => string,
): ChatSessionMeta[] {
  if (!opts.recentHours || opts.recentHours <= 0 || opts.sessionId || opts.all) return due;
  const nowMs = Date.parse(now());
  if (Number.isNaN(nowMs)) return due;
  const cutoff = nowMs - opts.recentHours * 3_600_000;
  return due.filter((s) => {
    if (!s.updatedAt) return true;
    const t = Date.parse(s.updatedAt);
    return Number.isNaN(t) || t >= cutoff;
  });
}
