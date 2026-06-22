import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatTurn, ExtractionResult, IntentExtractor } from "@ratel-ai/mcp-core";
import {
  HookChatSource,
  intentsPaths,
  NaiveIntentExtractor,
  nodeJsonFs,
  readChatState,
  readIntentsIndex,
  readRunLog,
  readSessionIntents,
  sessionTurnsPath,
  writeChatState,
} from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, createFsExtractionCache } from "./extraction-cache.js";
import { createSkillMatcher } from "./matcher.js";
import { applyRecencyWindow, runAnalysis, type SkillMatcher, selectDueSessions } from "./runner.js";

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

describe("applyRecencyWindow", () => {
  const now = () => "2026-06-22T12:00:00.000Z";
  const due = [
    {
      sessionId: "fresh",
      host: "claude-code",
      newTurnCount: 12,
      updatedAt: "2026-06-22T10:00:00.000Z",
    },
    {
      sessionId: "stale",
      host: "claude-code",
      newTurnCount: 12,
      updatedAt: "2026-06-20T10:00:00.000Z",
    },
    { sessionId: "unknown", host: "claude-code", newTurnCount: 12 },
  ];

  it("keeps only sessions updated within the window (unknown updatedAt kept)", () => {
    const kept = applyRecencyWindow(due, { recentHours: 5 }, now).map((s) => s.sessionId);
    expect(kept).toEqual(["fresh", "unknown"]);
  });

  it("is a no-op without recentHours, or for explicit sessionId/all", () => {
    expect(applyRecencyWindow(due, {}, now)).toHaveLength(3);
    expect(applyRecencyWindow(due, { recentHours: 5, all: true }, now)).toHaveLength(3);
    expect(applyRecencyWindow(due, { recentHours: 5, sessionId: "stale" }, now)).toHaveLength(3);
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

describe("runAnalysis reliability, caching, durability, telemetry", () => {
  /** A spy extractor that always returns one intent (deterministic). */
  function spyExtractor(): IntentExtractor & { extract: ReturnType<typeof vi.fn> } {
    const result: ExtractionResult = {
      claims: [],
      intents: [{ content: "add oauth login" }],
    };
    return {
      extract: vi.fn(async (_turns: ChatTurn[]) => result),
    };
  }

  function depsWith(
    overrides: Partial<ReturnType<typeof deps>> & { extractor?: IntentExtractor },
  ): ReturnType<typeof deps> {
    return { ...deps(stubMatcher), ...overrides };
  }

  it("records a failing session in errors and continues the batch", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 12 }, [
      { role: "user", content: "boom" },
    ]);
    await seedSession("claude-code", "s2", { newTurnCount: 12 }, [
      { role: "user", content: "Now write tests for it" },
    ]);

    const failing: IntentExtractor = {
      async extract(turns) {
        if (turns.some((t) => t.content === "boom")) {
          throw new Error("extractor exploded");
        }
        return { claims: [], intents: [{ content: "write tests" }] };
      },
    };

    const result = await runAnalysis(depsWith({ extractor: failing }), { all: true });

    expect(result.analyzed).toEqual(["s2"]);
    expect(result.errors).toEqual([{ sessionId: "s1", message: "extractor exploded" }]);
    // the healthy session still persisted
    expect(await readSessionIntents(nodeJsonFs, intentsDir, "s2")).not.toBeNull();
  });

  it("uses the cache on a hit and skips the extractor", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 12 }, [
      { role: "user", content: "Add OAuth login" },
    ]);
    const extractor = spyExtractor();
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    const turns = await new HookChatSource({ chatDir, fs: nodeJsonFs }).readSession("s1");
    await cache.set(cacheKey(turns, "model-x"), { claims: [], intents: [{ content: "cached" }] });

    await runAnalysis(depsWith({ extractor, cache, extractorModel: "model-x" }), { all: true });

    expect(extractor.extract).not.toHaveBeenCalled();
    const session = await readSessionIntents(nodeJsonFs, intentsDir, "s1");
    expect(session?.intents.map((i) => i.content)).toEqual(["cached"]);
  });

  it("bypassCache forces a fresh extraction even when a cache entry exists", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 12 }, [
      { role: "user", content: "Add OAuth login" },
    ]);
    const extractor = spyExtractor();
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    const turns = await new HookChatSource({ chatDir, fs: nodeJsonFs }).readSession("s1");
    await cache.set(cacheKey(turns, "model-x"), { claims: [], intents: [{ content: "stale" }] });

    await runAnalysis(depsWith({ extractor, cache, extractorModel: "model-x" }), {
      all: true,
      bypassCache: true,
    });

    expect(extractor.extract).toHaveBeenCalledTimes(1);
    const session = await readSessionIntents(nodeJsonFs, intentsDir, "s1");
    // fresh extraction (not the stale cached value), and the cache is refreshed
    expect(session?.intents.map((i) => i.content)).toEqual(["add oauth login"]);
  });

  it("calls the extractor once on a miss and populates the cache", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 12 }, [
      { role: "user", content: "Add OAuth login" },
    ]);
    const extractor = spyExtractor();
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);

    await runAnalysis(depsWith({ extractor, cache, extractorModel: "model-x" }), { all: true });

    expect(extractor.extract).toHaveBeenCalledTimes(1);
    const turns = await new HookChatSource({ chatDir, fs: nodeJsonFs }).readSession("s1");
    expect(await cache.get(cacheKey(turns, "model-x"))).toEqual({
      claims: [],
      intents: [{ content: "add oauth login" }],
    });
  });

  it("rebuilds the durable index from session files after a run", async () => {
    await seedSession("claude-code", "s1", { newTurnCount: 50 }, [
      { role: "user", content: "write tests for the parser" },
    ]);
    await seedSession("claude-code", "s2", { newTurnCount: 50 }, [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "deploy to production" },
    ]);

    await runAnalysis(deps(stubMatcher), { all: true });

    const index = await readIntentsIndex(nodeJsonFs, intentsDir);
    // de-dup: shared intent appears once, ranked first (seen in two sessions)
    const contents = index.intents.map((i) => i.content);
    expect(contents).toContain("write tests for the parser");
    expect(contents).toContain("deploy to production");
    const shared = index.intents.find((i) => i.content === "write tests for the parser");
    expect(shared?.sessions.sort()).toEqual(["s1", "s2"]);
  });

  it("appends exactly one run log entry with correct totals and per-session outcomes", async () => {
    await seedSession("claude-code", "ok1", { newTurnCount: 12 }, [
      { role: "user", content: "Now write tests for it" },
    ]);
    await seedSession("claude-code", "bad1", { newTurnCount: 12 }, [
      { role: "user", content: "boom" },
    ]);

    const failing: IntentExtractor = {
      async extract(turns) {
        if (turns.some((t) => t.content === "boom")) throw new Error("nope");
        return { claims: [], intents: [{ content: "write tests" }] };
      },
    };
    let clock = 1000;
    const monotonic = () => {
      clock += 5;
      return clock;
    };

    await runAnalysis(depsWith({ extractor: failing, monotonic, extractorModel: "m1" }), {
      all: true,
      trigger: "all",
    });

    const log = await readRunLog(nodeJsonFs, intentsDir);
    expect(log).toHaveLength(1);
    const entry = log[0];
    expect(entry.trigger).toBe("all");
    expect(entry.model).toBe("m1");
    expect(entry.totalIntents).toBe(1);
    expect(entry.totalGaps).toBe(0);
    const byId = Object.fromEntries(entry.sessions.map((s) => [s.sessionId, s]));
    expect(byId.ok1).toMatchObject({ ok: true, intents: 1, gaps: 0, cacheHit: false });
    expect(byId.bad1).toMatchObject({ ok: false, error: "nope", cacheHit: false });
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
