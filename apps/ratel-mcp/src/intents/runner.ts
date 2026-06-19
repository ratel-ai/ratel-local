import {
  type ChatSessionMeta,
  type ChatSource,
  type IntentCoverage,
  type IntentExtractor,
  type JsonFs,
  mergeIntoIndex,
  readIntentsIndex,
  type SessionIntents,
  type StoredIntent,
  writeIntentsIndex,
  writeSessionIntents,
} from "@ratel-ai/mcp-core";

/** Default every-N-messages threshold when the config omits one. */
export const DEFAULT_EVERY_N_MESSAGES = 10;

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
}

export interface RunAnalysisResult {
  analyzed: string[];
  skipped: string[];
  intentsFound: number;
  gaps: number;
}

/**
 * The single unit every trigger (manual button/CLI, idle Stop hook, every-N
 * threshold) calls. Selects the due sessions, extracts intents via the
 * configured {@link IntentExtractor}, annotates each with skill coverage,
 * persists the per-session result + cumulative index, and marks the session
 * analyzed so its new-turn counter resets.
 */
export async function runAnalysis(
  deps: AnalysisRunnerDeps,
  opts: RunAnalysisOptions = {},
): Promise<RunAnalysisResult> {
  const everyN = opts.everyNMessages ?? DEFAULT_EVERY_N_MESSAGES;
  const sessions = await deps.chatSource.listSessions();
  const due = selectDueSessions(sessions, opts, everyN);

  const result: RunAnalysisResult = { analyzed: [], skipped: [], intentsFound: 0, gaps: 0 };

  for (const meta of due) {
    const turns = await deps.chatSource.readSession(meta.sessionId);
    if (turns.length === 0) {
      result.skipped.push(meta.sessionId);
      continue;
    }

    const { claims, intents } = await deps.extractor.extract(turns);
    const storedIntents: StoredIntent[] = [];
    for (const intent of intents) {
      const matches = await deps.matchSkill(intent.content, meta.cwd);
      const coverage: IntentCoverage =
        matches.length > 0 ? { status: "covered", skills: matches } : { status: "gap" };
      const stored: StoredIntent = { content: intent.content, coverage };
      if (intent.evidences) stored.evidences = intent.evidences;
      storedIntents.push(stored);
    }

    const now = deps.now();
    const session: SessionIntents = {
      sessionId: meta.sessionId,
      host: meta.host,
      cwd: meta.cwd,
      analyzedAt: now,
      claims,
      intents: storedIntents,
    };

    await writeSessionIntents(deps.fs, deps.intentsDir, session);
    const index = await readIntentsIndex(deps.fs, deps.intentsDir);
    await writeIntentsIndex(deps.fs, deps.intentsDir, mergeIntoIndex(index, session, now));
    await deps.chatSource.markAnalyzed?.(meta.sessionId, now);

    result.analyzed.push(meta.sessionId);
    result.intentsFound += storedIntents.length;
    result.gaps += storedIntents.filter((i) => i.coverage.status === "gap").length;
    deps.log?.(
      `[ratel] analyzed ${meta.sessionId}: ${storedIntents.length} intents, ` +
        `${storedIntents.filter((i) => i.coverage.status === "gap").length} gaps`,
    );
  }

  return result;
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
    (s) => s.newTurnCount >= everyN || (Boolean(opts.onIdle) && s.idle === true),
  );
}
