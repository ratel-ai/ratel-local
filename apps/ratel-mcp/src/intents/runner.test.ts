import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HookChatSource,
  intentsPaths,
  NaiveIntentExtractor,
  nodeJsonFs,
  readChatState,
  readIntentsIndex,
  readSessionIntents,
  sessionTurnsPath,
  writeChatState,
} from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSkillMatcher } from "./matcher.js";
import { runAnalysis, type SkillMatcher, selectDueSessions } from "./runner.js";

let ratelDir: string;
let chatDir: string;
let intentsDir: string;
const NOW = "2026-06-19T10:00:00.000Z";

beforeEach(async () => {
  ratelDir = await mkdtemp(join(tmpdir(), "ratel-runner-"));
  const paths = intentsPaths(ratelDir);
  chatDir = paths.chatDir;
  intentsDir = paths.intentsDir;
});

afterEach(async () => {
  await rm(ratelDir, { recursive: true, force: true });
});

async function seedSession(
  host: string,
  sessionId: string,
  meta: { newTurnCount: number; idle?: boolean; cwd?: string },
  turns: Array<{ role: string; content: string }>,
): Promise<void> {
  const lines = turns.map((t) => JSON.stringify(t)).join("\n");
  await nodeJsonFs.writeAtomic(sessionTurnsPath(chatDir, host, sessionId), `${lines}\n`);
  const state = await readChatState(nodeJsonFs, chatDir);
  state.sessions[sessionId] = { sessionId, host, ...meta };
  await writeChatState(nodeJsonFs, chatDir, state);
}

/** A deterministic matcher: "write tests" is covered; everything else is a gap. */
const stubMatcher: SkillMatcher = async (text) =>
  /test/i.test(text) ? [{ skillId: "tdd", score: 4.2 }] : [];

function deps(matchSkill: SkillMatcher) {
  return {
    fs: nodeJsonFs,
    intentsDir,
    chatSource: new HookChatSource({ chatDir, fs: nodeJsonFs }),
    extractor: new NaiveIntentExtractor(),
    matchSkill,
    now: () => NOW,
  };
}

describe("selectDueSessions", () => {
  const sessions = [
    { sessionId: "a", host: "claude-code", newTurnCount: 12 },
    { sessionId: "b", host: "claude-code", newTurnCount: 1, idle: true },
    { sessionId: "c", host: "codex", newTurnCount: 0 },
  ];

  it("picks an explicit session id", () => {
    expect(selectDueSessions(sessions, { sessionId: "c" }, 10).map((s) => s.sessionId)).toEqual([
      "c",
    ]);
  });

  it("picks all when all=true", () => {
    expect(selectDueSessions(sessions, { all: true }, 10)).toHaveLength(3);
  });

  it("picks sessions over the threshold", () => {
    expect(selectDueSessions(sessions, {}, 10).map((s) => s.sessionId)).toEqual(["a"]);
  });

  it("includes idle sessions only when onIdle is set", () => {
    expect(selectDueSessions(sessions, { onIdle: true }, 10).map((s) => s.sessionId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("runAnalysis", () => {
  it("extracts, annotates coverage, persists, and resets state for a due session", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 12 }, [
      { role: "user", content: "Add OAuth login to my app" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Now write tests for it" },
    ]);

    const result = await runAnalysis(deps(stubMatcher), { everyNMessages: 10 });

    expect(result.analyzed).toEqual(["s1"]);
    expect(result.intentsFound).toBe(2);
    expect(result.gaps).toBe(1);

    const session = await readSessionIntents(nodeJsonFs, intentsDir, "s1");
    expect(session?.intents.map((i) => i.coverage.status)).toEqual(["gap", "covered"]);

    const index = await readIntentsIndex(nodeJsonFs, intentsDir);
    expect(index.intents).toHaveLength(2);
    expect(index.sessions[0]).toMatchObject({ sessionId: "s1", intentCount: 2, gapCount: 1 });

    // state reset: the new-turn counter is cleared and lastAnalyzedAt stamped
    const state = await readChatState(nodeJsonFs, chatDir);
    expect(state.sessions.s1.newTurnCount).toBe(0);
    expect(state.sessions.s1.lastAnalyzedAt).toBe(NOW);
  });

  it("skips sessions below the threshold", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 2 }, [{ role: "user", content: "hi" }]);
    const result = await runAnalysis(deps(stubMatcher), { everyNMessages: 10 });
    expect(result.analyzed).toEqual([]);
  });

  it("analyzes an idle session when onIdle is set", async () => {
    await seedSession("codex", "s2", { newTurnCount: 0, idle: true }, [
      { role: "user", content: "deploy my app" },
    ]);
    const result = await runAnalysis(deps(stubMatcher), { everyNMessages: 10, onIdle: true });
    expect(result.analyzed).toEqual(["s2"]);
  });
});

describe("createSkillMatcher (integration with suggestSkills)", () => {
  it("reports covered for a clear lexical match and a gap otherwise", async () => {
    const skillsDir = join(ratelDir, "skills");
    await mkdir(join(skillsDir, "tdd-workflow"), { recursive: true });
    await writeFile(
      join(skillsDir, "tdd-workflow", "SKILL.md"),
      [
        "---",
        "name: tdd-workflow",
        "description: Write unit tests first then implement to pass them",
        "tags: [tests, testing, tdd, unit tests]",
        "---",
        "# TDD",
        "Write a failing test, make it pass, refactor.",
      ].join("\n"),
    );

    // Explicit floor so this exercises the matcher logic, not the production default.
    const match = createSkillMatcher({ dirs: [skillsDir], minScore: 0.5 });
    const covered = await match("write unit tests for my module");
    expect(covered.map((m) => m.skillId)).toContain("tdd-workflow");
    const gap = await match("provision a kubernetes cluster on bare metal");
    expect(gap).toEqual([]);
  });
});

describe("end-to-end with the real matcher", () => {
  it("flags an uncovered intent as a gap and a covered one as covered", async () => {
    const skillsDir = join(ratelDir, "skills");
    await mkdir(join(skillsDir, "tdd-workflow"), { recursive: true });
    await writeFile(
      join(skillsDir, "tdd-workflow", "SKILL.md"),
      [
        "---",
        "name: tdd-workflow",
        "description: Write unit tests first then implement",
        "tags: [tests, testing, write tests]",
        "---",
        "# TDD",
      ].join("\n"),
    );
    await seedSession("claude-code", "s9", { newTurnCount: 50 }, [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "set up a grafana dashboard with prometheus" },
    ]);

    await runAnalysis(deps(createSkillMatcher({ dirs: [skillsDir], minScore: 0.5 })), {
      all: true,
    });

    const index = await readIntentsIndex(nodeJsonFs, intentsDir);
    const byContent = Object.fromEntries(index.intents.map((i) => [i.content, i.coverage.status]));
    expect(byContent["write tests for the parser"]).toBe("covered");
    expect(byContent["set up a grafana dashboard with prometheus"]).toBe("gap");
  });
});
