/**
 * Host turn correlation for adaptive ranking.
 *
 * A host hook (Claude Code or Codex `PreToolUse`) may add one reserved,
 * top-level argument to a gateway tool call, naming the host's own session,
 * user turn, and, for a subagent, its agent id. Ratel turns it into the SDK
 * `turnId`, so a search pairs only with invokes from the same host turn. See
 * docs/adr/0023-host-turn-correlation.md.
 *
 * The argument is Ratel's, never the tool's: it is stripped from every gateway
 * call, whether or not the feature is on, before anything reaches the SDK or an
 * upstream server.
 */

/** The reserved argument name. */
export const TURN_CORRELATION_ARG = "_ratel";

/** Longest id accepted in any field; anything longer is ignored. */
export const TURN_CORRELATION_MAX_ID_LENGTH = 256;

/** The host's native ids for one call. */
export interface TurnCorrelation {
  /** Host session id (Claude Code and Codex `session_id`). */
  session: string;
  /** Host turn id (Claude Code `prompt_id`, Codex `turn_id`). */
  turn: string;
  /** Subagent id (`agent_id`), absent on the main thread. */
  agent?: string;
}

/** Version prefix of every composite key; a bare connection UUID never has it. */
const KEY_PREFIX = "rt1";

/**
 * Split the reserved argument off a gateway call. Always returns the arguments
 * without it; `correlation` is set only when the value is well formed. The input
 * object is never mutated.
 */
export function extractTurnCorrelation(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  correlation: TurnCorrelation | undefined;
} {
  if (!Object.hasOwn(args, TURN_CORRELATION_ARG)) return { args, correlation: undefined };
  const { [TURN_CORRELATION_ARG]: raw, ...rest } = args;
  return { args: rest, correlation: parseTurnCorrelation(raw) };
}

/**
 * Encode a correlation as an SDK turn id. Each component is percent-encoded, so
 * the `:` separator never appears inside one and the encoding is injective; the
 * component count tells the main thread from a subagent. Session and turn come
 * first, so every agent in one host turn shares a prefix.
 */
export function turnCorrelationKey(correlation: TurnCorrelation): string {
  const parts = [correlation.session, correlation.turn];
  if (correlation.agent !== undefined) parts.push(correlation.agent);
  return [KEY_PREFIX, ...parts.map(encodeURIComponent)].join(":");
}

function parseTurnCorrelation(raw: unknown): TurnCorrelation | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { session, turn, agent } = raw as Record<string, unknown>;
  if (!isId(session) || !isId(turn)) return undefined;
  if (agent !== undefined && !isId(agent)) return undefined;
  return { session, turn, ...(agent !== undefined ? { agent } : {}) };
}

function isId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= TURN_CORRELATION_MAX_ID_LENGTH
  );
}
