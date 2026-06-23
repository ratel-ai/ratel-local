/**
 * Data model + provider seams for the chat → intent extraction pipeline.
 *
 * Three swappable seams, each selected by the `analysis` config block:
 *  - {@link ChatSource}     — where captured chat comes from (hooks today; api/cloud later)
 *  - {@link IntentExtractor} — what turns conversation into claims + intents
 *  - {@link SkillGenerator}  — what drafts a new skill for an uncovered intent
 *
 * The shapes mirror the ClaimExtractor model output: `{ claims, intents }`.
 */

export type ChatRole = "user" | "assistant";

/** One conversation turn captured from a host (Claude Code / Codex). */
export interface ChatTurn {
  role: ChatRole;
  content: string;
  /** ISO timestamp when the turn was captured, if known. */
  ts?: string;
}

/** Per-session bookkeeping the capture layer maintains in `~/.ratel/chat/state.json`. */
export interface ChatSessionMeta {
  sessionId: string;
  /** Originating host: "claude-code" | "codex" | "unknown". */
  host: string;
  cwd?: string;
  /** Turns captured since the last analysis run (drives the every-N-messages trigger). */
  newTurnCount: number;
  /** ISO timestamp of the last completed analysis for this session. */
  lastAnalyzedAt?: string;
  /** ISO timestamp of the most recent captured turn. */
  updatedAt?: string;
  /** True once the session has gone idle (set by the Stop hook); drives the idle trigger. */
  idle?: boolean;
  /**
   * Set when this session's analysis output was deleted (e.g. "clear all"), so a run
   * treats it as due again even without new turns — otherwise the bookkeeping claims
   * "already analyzed" while the store is empty and a re-run would skip it. Cleared
   * once the session is analyzed.
   */
  needsReanalysis?: boolean;
}

/** Claim subtypes emitted by the ClaimExtractor model. */
export type ClaimSubtype = "factoid" | "capability" | "user_assertion" | "unverifiable";

export interface Claim {
  subtype: ClaimSubtype;
  content: string;
  /** Supporting spans; the current model release does not populate these yet. */
  evidences?: string[];
}

/** A user goal/request extracted from the conversation. */
export interface Intent {
  content: string;
  evidences?: string[];
}

/** Structured output of an {@link IntentExtractor}. */
export interface ExtractionResult {
  claims: Claim[];
  intents: Intent[];
}

/** Optional description of the AI service being analyzed (passed through to the model). */
export interface AIServiceDescription {
  name?: string;
  description?: string;
  capabilities?: string[];
}

/** Reads captured chat. Implementations: hook files (v1), remote API/cloud (future). */
export interface ChatSource {
  /** All sessions known to this source, with per-session bookkeeping. */
  listSessions(): Promise<ChatSessionMeta[]>;
  /** The full ordered turn list for one session. */
  readSession(sessionId: string): Promise<ChatTurn[]>;
  /**
   * Record that a session was just analyzed: reset its new-turn counter, stamp
   * `lastAnalyzedAt`, and clear the idle flag. Optional so read-only sources can
   * omit it; the runner calls it after each successful analysis.
   */
  markAnalyzed?(sessionId: string, at: string): Promise<void>;
}

/** Turns conversation into claims + intents. Implementations: http sidecar/remote, naive fallback. */
export interface IntentExtractor {
  extract(turns: ChatTurn[], serviceDescription?: AIServiceDescription): Promise<ExtractionResult>;
}

/** A generated skill draft, shaped for the existing create-skill route. */
export interface SkillDraft {
  /** kebab-case skill id / folder name. */
  name: string;
  description: string;
  tags?: string[];
  /** Markdown body for SKILL.md (excluding frontmatter). */
  body: string;
}

/** Context handed to a {@link SkillGenerator} so drafts avoid duplicating existing skills. */
export interface SkillGenContext {
  existingSkillIds?: string[];
  cwd?: string;
  /**
   * Representative evidence snippets/turns for the intent, so a generator can
   * ground the skill in what the user actually did.
   */
  evidences?: string[];
  /** Other intents seen in the same session(s), for additional context. */
  relatedIntents?: string[];
}

/** Drafts a new skill for an uncovered intent. Implementations: anthropic-api, claude-cli. */
export interface SkillGenerator {
  generate(intent: Intent, context?: SkillGenContext): Promise<SkillDraft>;
}

/** A skill that matches an intent, with its BM25 relevance score. */
export interface CoveredSkill {
  skillId: string;
  score: number;
}

/**
 * Whether managed skills cover an intent. `skills` is the BM25-ranked list of
 * matches (best first), mirroring the gateway's capability search — an intent
 * can be covered by more than one skill.
 */
export type IntentCoverage = { status: "covered"; skills: CoveredSkill[] } | { status: "gap" };

/** A de-duplicated intent in the cumulative index, with coverage and session provenance. */
export interface IntentRecord {
  /** Normalized intent text used as the de-dup key. */
  content: string;
  coverage: IntentCoverage;
  /** Session ids this intent was observed in. */
  sessions: string[];
  firstSeen: string;
  lastSeen: string;
  /** Ranking score (currently session frequency), for ranking transparency. */
  score?: number;
  /** Evidence spans/turns that support this intent (from the newest session), as proof. */
  evidences?: string[];
}

/** One session's outcome within a single analysis run, for run telemetry. */
export interface RunLogSessionEntry {
  sessionId: string;
  host?: string;
  ok: boolean;
  error?: string;
  intents: number;
  gaps: number;
  turns: number;
  latencyMs: number;
  cacheHit: boolean;
}

/** A single analysis run, appended to the runs telemetry log. */
export interface RunLogEntry {
  runId: string;
  /** ISO timestamp. */
  at: string;
  /** "manual" | "idle" | "cadence" | "all" | "session" */
  trigger: string;
  model?: string;
  durationMs: number;
  totalIntents: number;
  totalGaps: number;
  sessions: RunLogSessionEntry[];
}
