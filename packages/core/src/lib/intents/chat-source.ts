import { join } from "node:path";
import { type JsonFs, readJson, writeJson } from "../../io.js";
import type { ChatRole, ChatSessionMeta, ChatSource, ChatTurn } from "./types.js";

export const CHAT_STATE_VERSION = 1;

/** Hosts the capture hook may write under; used to locate turn files when state lacks a session. */
const KNOWN_HOSTS = ["claude-code", "codex", "unknown"] as const;

/**
 * Per-session bookkeeping persisted by the capture hook at `<chatDir>/state.json`.
 * Kept in sync (by format) with `apps/ratel-mcp/plugin/hooks/capture-chat.mjs`.
 */
export interface ChatState {
  version: number;
  sessions: Record<string, ChatSessionMeta>;
}

/** Absolute path to a session's append-only turn log: `<chatDir>/<host>/<sessionId>.jsonl`. */
export function sessionTurnsPath(chatDir: string, host: string, sessionId: string): string {
  return join(chatDir, host, `${sessionId}.jsonl`);
}

function chatStatePath(chatDir: string): string {
  return join(chatDir, "state.json");
}

/** Read chat capture state; recovers to an empty state when missing or malformed. */
export async function readChatState(fs: JsonFs, chatDir: string): Promise<ChatState> {
  try {
    const state = await readJson<ChatState>(fs, chatStatePath(chatDir));
    if (state && typeof state === "object" && state.sessions) return state;
  } catch {
    // malformed JSON — fall through to an empty state
  }
  return { version: CHAT_STATE_VERSION, sessions: {} };
}

/** Atomically persist chat capture state. */
export async function writeChatState(fs: JsonFs, chatDir: string, state: ChatState): Promise<void> {
  await writeJson(fs, chatStatePath(chatDir), state);
}

export interface HookChatSourceOptions {
  /** The `~/.ratel/chat` directory the capture hook writes to. */
  chatDir: string;
  fs: JsonFs;
}

/**
 * Reads chat captured by the plugin hooks from `<chatDir>`. The default v1 input
 * seam; future `ApiChatSource`/`CloudChatSource` implement the same
 * {@link ChatSource} interface so call sites never change.
 */
export class HookChatSource implements ChatSource {
  private readonly chatDir: string;
  private readonly fs: JsonFs;

  constructor(opts: HookChatSourceOptions) {
    this.chatDir = opts.chatDir;
    this.fs = opts.fs;
  }

  async listSessions(): Promise<ChatSessionMeta[]> {
    const state = await readChatState(this.fs, this.chatDir);
    return Object.values(state.sessions);
  }

  async readSession(sessionId: string): Promise<ChatTurn[]> {
    const state = await readChatState(this.fs, this.chatDir);
    const host = state.sessions[sessionId]?.host;
    const hosts = host ? [host] : KNOWN_HOSTS;
    for (const h of hosts) {
      const raw = await this.fs.read(sessionTurnsPath(this.chatDir, h, sessionId));
      if (raw !== null) return parseTurns(raw);
    }
    return [];
  }

  async markAnalyzed(sessionId: string, at: string): Promise<void> {
    const state = await readChatState(this.fs, this.chatDir);
    const meta = state.sessions[sessionId];
    if (!meta) return;
    const next: ChatState = {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: { ...meta, newTurnCount: 0, lastAnalyzedAt: at, idle: false },
      },
    };
    await writeChatState(this.fs, this.chatDir, next);
  }
}

function parseTurns(raw: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const turn = parseTurn(trimmed);
    if (turn) turns.push(turn);
  }
  return turns;
}

function parseTurn(line: string): ChatTurn | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const role = obj.role;
  const content = obj.content;
  if ((role !== "user" && role !== "assistant") || typeof content !== "string") return undefined;
  const turn: ChatTurn = { role: role as ChatRole, content };
  if (typeof obj.ts === "string") turn.ts = obj.ts;
  return turn;
}
