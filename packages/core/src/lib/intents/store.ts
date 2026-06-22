import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type JsonFs, readJson, writeJson } from "../../io.js";
import type { Claim, IntentCoverage, IntentRecord } from "./types.js";

export const INTENTS_INDEX_VERSION = 1;

/** One intent within a session result, annotated with skill coverage. */
export interface StoredIntent {
  content: string;
  evidences?: string[];
  coverage: IntentCoverage;
}

/** Full per-session extraction result, persisted at `<intentsDir>/<sessionId>.json`. */
export interface SessionIntents {
  sessionId: string;
  host?: string;
  cwd?: string;
  analyzedAt: string;
  claims: Claim[];
  intents: StoredIntent[];
}

/** Compact per-session entry in the cumulative index, for UI session grouping. */
export interface SessionSummary {
  sessionId: string;
  host?: string;
  cwd?: string;
  analyzedAt: string;
  intentCount: number;
  gapCount: number;
}

/**
 * The cumulative, de-duplicated index the UI reads — a single artifact that
 * supports both the cumulative list (`intents`) and per-session grouping
 * (`sessions`), so the UI never needs to enumerate per-session files.
 */
export interface IntentsIndex {
  version: number;
  intents: IntentRecord[];
  sessions: SessionSummary[];
}

function indexPath(intentsDir: string): string {
  return join(intentsDir, "index.json");
}

function sessionPath(intentsDir: string, sessionId: string): string {
  return join(intentsDir, "sessions", `${sessionId}.json`);
}

export function emptyIndex(): IntentsIndex {
  return { version: INTENTS_INDEX_VERSION, intents: [], sessions: [] };
}

/** Read the cumulative index; recovers to an empty index when missing or malformed. */
export async function readIntentsIndex(fs: JsonFs, intentsDir: string): Promise<IntentsIndex> {
  try {
    const index = await readJson<IntentsIndex>(fs, indexPath(intentsDir));
    if (index && Array.isArray(index.intents) && Array.isArray(index.sessions)) return index;
  } catch {
    // malformed — fall through to an empty index
  }
  return emptyIndex();
}

export async function writeIntentsIndex(
  fs: JsonFs,
  intentsDir: string,
  index: IntentsIndex,
): Promise<void> {
  await writeJson(fs, indexPath(intentsDir), index);
}

export async function readSessionIntents(
  fs: JsonFs,
  intentsDir: string,
  sessionId: string,
): Promise<SessionIntents | null> {
  try {
    return await readJson<SessionIntents>(fs, sessionPath(intentsDir, sessionId));
  } catch {
    return null;
  }
}

export async function writeSessionIntents(
  fs: JsonFs,
  intentsDir: string,
  session: SessionIntents,
): Promise<void> {
  await writeJson(fs, sessionPath(intentsDir, session.sessionId), session);
}

/** Remove a single intent (matched by normalized content) from the index. */
export function removeIntent(index: IntentsIndex, content: string): IntentsIndex {
  const key = normalizeIntentKey(content);
  const intents = index.intents.filter((i) => normalizeIntentKey(i.content) !== key);
  return reindexSessions({ ...index, intents });
}

/** Recompute each session summary's counts from the surviving intents; drop now-empty sessions. */
function reindexSessions(index: IntentsIndex): IntentsIndex {
  const sessions = index.sessions
    .map((s) => {
      const own = index.intents.filter((i) => i.sessions.includes(s.sessionId));
      return {
        ...s,
        intentCount: own.length,
        gapCount: own.filter((i) => i.coverage.status === "gap").length,
      };
    })
    .filter((s) => s.intentCount > 0);
  return { ...index, sessions };
}

/** Normalize intent text into a de-dup key: lowercased, whitespace-collapsed, depunctuated. */
export function normalizeIntentKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

/**
 * Fold one session's analyzed intents into the cumulative index (pure). Intents
 * are de-duped by {@link normalizeIntentKey}: a repeat updates `lastSeen`,
 * appends the session to `sessions`, and refreshes `coverage` (skills may have
 * been added since); `firstSeen` is preserved. The session summary is upserted.
 */
export function mergeIntoIndex(
  index: IntentsIndex,
  session: SessionIntents,
  now: string,
): IntentsIndex {
  // Replace this session's prior contribution: strip it from every record and
  // drop records left with no sessions, so re-analyzing a session (Run now)
  // refreshes its intents instead of accumulating stale or re-worded phrasings.
  const priorByKey = new Map(index.intents.map((r) => [normalizeIntentKey(r.content), r]));
  const retained = index.intents
    .map((r) => ({ ...r, sessions: r.sessions.filter((s) => s !== session.sessionId) }))
    .filter((r) => r.sessions.length > 0);
  const byKey = new Map(retained.map((r) => [normalizeIntentKey(r.content), r]));

  for (const intent of session.intents) {
    const key = normalizeIntentKey(intent.content);
    if (key.length === 0) continue;
    const existing = byKey.get(key);
    if (existing) {
      const sessions = existing.sessions.includes(session.sessionId)
        ? existing.sessions
        : [...existing.sessions, session.sessionId];
      byKey.set(key, {
        ...existing,
        coverage: intent.coverage,
        sessions,
        lastSeen: now,
      });
    } else {
      byKey.set(key, {
        content: intent.content,
        coverage: intent.coverage,
        sessions: [session.sessionId],
        // Preserve the original firstSeen when an intent recurs across re-runs.
        firstSeen: priorByKey.get(key)?.firstSeen ?? now,
        lastSeen: now,
      });
    }
  }

  const summary: SessionSummary = {
    sessionId: session.sessionId,
    host: session.host,
    cwd: session.cwd,
    analyzedAt: session.analyzedAt,
    intentCount: session.intents.length,
    gapCount: session.intents.filter((i) => i.coverage.status === "gap").length,
  };
  const sessions = [...index.sessions.filter((s) => s.sessionId !== session.sessionId), summary];

  return { version: INTENTS_INDEX_VERSION, intents: [...byKey.values()], sessions };
}

/**
 * Read every per-session file under `<intentsDir>/sessions/*.json`. Missing or
 * malformed files are skipped (a missing directory yields `[]`). The result is
 * sorted by `analyzedAt` ascending for deterministic downstream rebuilds.
 */
export async function readAllSessionIntents(
  fs: JsonFs,
  intentsDir: string,
): Promise<SessionIntents[]> {
  let entries: string[];
  try {
    entries = await readdir(join(intentsDir, "sessions"));
  } catch {
    return [];
  }
  const sessionIds = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length));
  const sessions: SessionIntents[] = [];
  for (const sessionId of sessionIds) {
    const session = await readSessionIntents(fs, intentsDir, sessionId);
    if (session && Array.isArray(session.intents)) sessions.push(session);
  }
  return [...sessions].sort((a, b) => a.analyzedAt.localeCompare(b.analyzedAt));
}

/**
 * Rank intent records (pure): primary by session frequency DESC ("showed up in
 * 8 sessions" first), then `lastSeen` DESC, then `content` ASC for stability.
 * Returns a new array with `score` set to each record's session count.
 */
export function rankIntentRecords(records: IntentRecord[]): IntentRecord[] {
  return [...records]
    .map((r) => ({ ...r, score: r.sessions.length }))
    .sort((a, b) => {
      if (b.sessions.length !== a.sessions.length) return b.sessions.length - a.sessions.length;
      if (b.lastSeen !== a.lastSeen) return b.lastSeen.localeCompare(a.lastSeen);
      return a.content.localeCompare(b.content);
    });
}

/**
 * Rebuild the entire cumulative index from per-session files (pure). Deriving
 * the index from the durable per-session artifacts means it can always be
 * regenerated and never silently loses sessions or intents.
 *
 * Intents are de-duped by {@link normalizeIntentKey}. For each distinct key the
 * `sessions` list is every containing session (ordered by first appearance);
 * `firstSeen`/`lastSeen` span their `analyzedAt`; `content` and `coverage` come
 * from the most-recently-analyzed containing session (newest wins, since skills
 * change over time). Empty-key intents are skipped. `intents` is returned ranked
 * (see {@link rankIntentRecords}).
 */
export function rebuildIndex(sessions: SessionIntents[]): IntentsIndex {
  // Sessions sorted oldest → newest so "first appearance" ordering and
  // "newest wins" for content/coverage both fall out naturally.
  const ordered = [...sessions].sort((a, b) => a.analyzedAt.localeCompare(b.analyzedAt));
  const byKey = new Map<string, IntentRecord>();

  for (const session of ordered) {
    for (const intent of session.intents) {
      const key = normalizeIntentKey(intent.content);
      if (key.length === 0) continue;
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, {
          ...existing,
          // newest containing session wins for content + coverage + evidence
          content: intent.content,
          coverage: intent.coverage,
          evidences: intent.evidences ?? existing.evidences,
          sessions: existing.sessions.includes(session.sessionId)
            ? existing.sessions
            : [...existing.sessions, session.sessionId],
          firstSeen:
            session.analyzedAt < existing.firstSeen ? session.analyzedAt : existing.firstSeen,
          lastSeen: session.analyzedAt > existing.lastSeen ? session.analyzedAt : existing.lastSeen,
        });
      } else {
        byKey.set(key, {
          content: intent.content,
          coverage: intent.coverage,
          evidences: intent.evidences,
          sessions: [session.sessionId],
          firstSeen: session.analyzedAt,
          lastSeen: session.analyzedAt,
        });
      }
    }
  }

  const summaries: SessionSummary[] = ordered.map((session) => ({
    sessionId: session.sessionId,
    host: session.host,
    cwd: session.cwd,
    analyzedAt: session.analyzedAt,
    intentCount: session.intents.length,
    gapCount: session.intents.filter((i) => i.coverage.status === "gap").length,
  }));

  return {
    version: INTENTS_INDEX_VERSION,
    intents: rankIntentRecords([...byKey.values()]),
    sessions: summaries,
  };
}

/**
 * Strip an intent (matched by {@link normalizeIntentKey}) from every session's
 * `intents` array (pure), so a later {@link rebuildIndex} won't resurrect a
 * deleted intent. Inputs are never mutated.
 */
export function removeIntentFromSessions(
  sessions: SessionIntents[],
  content: string,
): SessionIntents[] {
  const key = normalizeIntentKey(content);
  return sessions.map((session) => ({
    ...session,
    intents: session.intents.filter((i) => normalizeIntentKey(i.content) !== key),
  }));
}
