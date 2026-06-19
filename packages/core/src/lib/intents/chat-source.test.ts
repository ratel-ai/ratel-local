import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeJsonFs, writeJson } from "../../io.js";
import type { ChatState } from "./chat-source.js";
import { HookChatSource, readChatState, sessionTurnsPath, writeChatState } from "./chat-source.js";

let dir: string;
let chatDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-chat-"));
  chatDir = join(dir, "chat");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedTurns(host: string, sessionId: string, lines: string[]): Promise<void> {
  await nodeJsonFs.writeAtomic(sessionTurnsPath(chatDir, host, sessionId), `${lines.join("\n")}\n`);
}

describe("readChatState / writeChatState", () => {
  it("returns an empty state when no file exists", async () => {
    const state = await readChatState(nodeJsonFs, chatDir);
    expect(state.sessions).toEqual({});
  });

  it("round-trips through an atomic write", async () => {
    const state: ChatState = {
      version: 1,
      sessions: { s1: { sessionId: "s1", host: "claude-code", newTurnCount: 3 } },
    };
    await writeChatState(nodeJsonFs, chatDir, state);
    const read = await readChatState(nodeJsonFs, chatDir);
    expect(read.sessions.s1.newTurnCount).toBe(3);
  });

  it("recovers to an empty state on malformed JSON", async () => {
    await nodeJsonFs.writeAtomic(join(chatDir, "state.json"), "{not json");
    const state = await readChatState(nodeJsonFs, chatDir);
    expect(state.sessions).toEqual({});
  });
});

describe("HookChatSource", () => {
  it("lists sessions from state.json", async () => {
    await writeJson(nodeJsonFs, join(chatDir, "state.json"), {
      version: 1,
      sessions: {
        s1: { sessionId: "s1", host: "claude-code", newTurnCount: 2, cwd: "/proj" },
        s2: { sessionId: "s2", host: "codex", newTurnCount: 0 },
      },
    });
    const source = new HookChatSource({ chatDir, fs: nodeJsonFs });
    const sessions = await source.listSessions();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("reads and parses a session's turns, skipping malformed lines", async () => {
    await writeJson(nodeJsonFs, join(chatDir, "state.json"), {
      version: 1,
      sessions: { s1: { sessionId: "s1", host: "claude-code", newTurnCount: 2 } },
    });
    await seedTurns("claude-code", "s1", [
      JSON.stringify({ role: "user", content: "first" }),
      "{ broken line",
      "",
      JSON.stringify({ role: "assistant", content: "second" }),
      JSON.stringify({ role: "user" }), // missing content → dropped
    ]);
    const source = new HookChatSource({ chatDir, fs: nodeJsonFs });
    const turns = await source.readSession("s1");
    expect(turns).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("returns an empty array for an unknown session", async () => {
    const source = new HookChatSource({ chatDir, fs: nodeJsonFs });
    expect(await source.readSession("nope")).toEqual([]);
  });

  it("falls back to scanning known host dirs when state lacks the session", async () => {
    await seedTurns("codex", "orphan", [JSON.stringify({ role: "user", content: "hi" })]);
    const source = new HookChatSource({ chatDir, fs: nodeJsonFs });
    const turns = await source.readSession("orphan");
    expect(turns).toEqual([{ role: "user", content: "hi" }]);
  });
});
