import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nodeFs,
  nodeJsonFs,
  type SkillDraft,
  type SkillGenContext,
  type SkillGenerator,
} from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedArgs } from "../cli/args.js";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { silentPromptAdapter } from "../cli/prompts.js";
import { SECRET_MASK } from "./analysis-settings.js";
import {
  clearIntentsRoute,
  clearOfferJobRoute,
  deleteChatRoute,
  deleteIntentRoute,
  getAnalysisSettings,
  getChatRoute,
  getChatsRoute,
  getIntents,
  getObservabilityRoute,
  getSessionIntents,
  listOfferJobsRoute,
  offerSkillRoute,
  offerStatusRoute,
  putAnalysisSettings,
  runIntentsRoute,
} from "./intents-routes.js";

let home: string;
let ratelDir: string;
let ctx: HandlerCtx;
const prevRatelHome = process.env.RATEL_HOME;

const ARGV: ParsedArgs = {
  group: "ui",
  configPaths: [],
  rest: [],
  extras: [],
  flags: {},
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ratel-iroutes-"));
  ratelDir = join(home, ".ratel");
  process.env.RATEL_HOME = ratelDir;
  ctx = {
    argv: ARGV,
    env: { homeDir: home },
    fs: nodeFs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
});

afterEach(async () => {
  if (prevRatelHome === undefined) delete process.env.RATEL_HOME;
  else process.env.RATEL_HOME = prevRatelHome;
  await rm(home, { recursive: true, force: true });
});

async function seedChat(
  sessionId: string,
  turns: Array<{ role: string; content: string }>,
  meta: Record<string, unknown> = {},
) {
  const file = join(ratelDir, "chat", "claude-code", `${sessionId}.jsonl`);
  await nodeJsonFs.writeAtomic(file, `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`);
  // Merge with any existing state so multiple seedChat calls accumulate sessions.
  const statePath = join(ratelDir, "chat", "state.json");
  const existing = await nodeFs.read(statePath);
  const state = existing
    ? (JSON.parse(existing) as { version: number; sessions: Record<string, unknown> })
    : { version: 1, sessions: {} };
  state.sessions[sessionId] = {
    sessionId,
    host: "claude-code",
    newTurnCount: 99,
    updatedAt: new Date().toISOString(),
    ...meta,
  };
  await nodeJsonFs.writeAtomic(statePath, JSON.stringify(state));
}

/** Wait for the fire-and-forget run to finish (getIntents.running → false). */
async function waitForIdle() {
  for (let i = 0; i < 200; i++) {
    const body = (await getIntents(ctx)).body as { running?: boolean };
    if (!body.running) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("analysis run did not finish");
}

async function seedSkill(name: string, description: string, tags: string[]) {
  const dir = join(ratelDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      `tags: [${tags.join(", ")}]`,
      "---",
      "# x",
    ].join("\n"),
  );
}

describe("getIntents", () => {
  it("returns an empty index before any run", async () => {
    const res = await getIntents(ctx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intents: [], sessions: [] });
  });
});

describe("runIntentsRoute + getIntents + getSessionIntents", () => {
  it("analyzes, then serves cumulative + per-session intents", async () => {
    await seedSkill(
      "tdd-workflow",
      "Write unit tests for parsers and modules before implementing",
      ["tests", "testing", "write tests", "unit tests", "parser"],
    );
    await seedChat("sess-1", [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "set up a grafana dashboard with prometheus" },
    ]);

    const run = await runIntentsRoute(ctx, {});
    expect(run.body).toMatchObject({ started: true });
    await waitForIdle();

    const index = (await getIntents(ctx)).body as {
      intents: Array<{ content: string; coverage: { status: string } }>;
      sessions: Array<{ sessionId: string }>;
    };
    const byContent = Object.fromEntries(index.intents.map((i) => [i.content, i.coverage.status]));
    expect(byContent["write tests for the parser"]).toBe("covered");
    expect(byContent["set up a grafana dashboard with prometheus"]).toBe("gap");
    expect(index.sessions[0].sessionId).toBe("sess-1");

    const session = await getSessionIntents(ctx, "sess-1");
    expect(session.status).toBe(200);

    const missing = await getSessionIntents(ctx, "nope");
    expect(missing.status).toBe(404);
  });
});

describe("master switch (enabled)", () => {
  it("does not run and reports disabled when analysis is off", async () => {
    await putAnalysisSettings(ctx, { analysis: { enabled: false } });
    const run = await runIntentsRoute(ctx, {});
    expect(run.body).toMatchObject({ started: false, disabled: true });
    const index = (await getIntents(ctx)).body as { enabled: boolean };
    expect(index.enabled).toBe(false);
  });

  it("reports enabled by default (flag unset)", async () => {
    const index = (await getIntents(ctx)).body as { enabled: boolean };
    expect(index.enabled).toBe(true);
  });
});

describe("deleteIntentRoute + clearIntentsRoute", () => {
  async function seedAndRun() {
    await seedSkill("tdd-workflow", "Write unit tests first then implement", ["write tests"]);
    await seedChat("sess-1", [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "set up a grafana dashboard" },
    ]);
    await runIntentsRoute(ctx, {});
    await waitForIdle();
  }

  it("deletes a single intent by content", async () => {
    await seedAndRun();
    await deleteIntentRoute(ctx, { content: "set up a grafana dashboard" });
    const index = (await getIntents(ctx)).body as { intents: Array<{ content: string }> };
    expect(index.intents.map((i) => i.content)).toEqual(["write tests for the parser"]);
  });

  it("makes a deletion survive a rebuild from session files", async () => {
    await seedAndRun();
    await deleteIntentRoute(ctx, { content: "set up a grafana dashboard" });

    // Rebuild from the durable per-session files: the deleted intent must stay gone.
    const { readAllSessionIntents, rebuildIndex } = await import("@ratel-ai/mcp-core");
    const { intentsPaths, resolveRatelDir } = await import("@ratel-ai/mcp-core");
    const intentsDir = intentsPaths(resolveRatelDir(process.env, home)).intentsDir;
    const rebuilt = rebuildIndex(await readAllSessionIntents(nodeFs, intentsDir));
    expect(rebuilt.intents.map((i) => i.content)).toEqual(["write tests for the parser"]);
  });

  it("requires content", async () => {
    await expect(deleteIntentRoute(ctx, { content: "  " })).rejects.toThrow(/content is required/);
  });

  it("clears every intent durably", async () => {
    await seedAndRun();
    await clearIntentsRoute(ctx);
    const index = (await getIntents(ctx)).body as { intents: unknown[]; sessions: unknown[] };
    expect(index.intents).toEqual([]);
    expect(index.sessions).toEqual([]);

    // A rebuild from the (now removed) session files stays empty too.
    const { readAllSessionIntents, rebuildIndex } = await import("@ratel-ai/mcp-core");
    const { intentsPaths, resolveRatelDir } = await import("@ratel-ai/mcp-core");
    const intentsDir = intentsPaths(resolveRatelDir(process.env, home)).intentsDir;
    const rebuilt = rebuildIndex(await readAllSessionIntents(nodeFs, intentsDir));
    expect(rebuilt.intents).toEqual([]);
  });
});

describe("analysis settings routes", () => {
  it("persists settings and masks the apiKey on read", async () => {
    await putAnalysisSettings(ctx, {
      analysis: {
        enabled: true,
        cadence: { everyNMessages: 5, onIdle: true },
        extractor: { endpoint: "http://127.0.0.1:8723", apiKey: "sk-secret" },
      },
    });
    const res = (await getAnalysisSettings(ctx)).body as {
      analysis: { cadence?: { everyNMessages?: number }; extractor?: { apiKey?: string } };
      secretMask: string;
    };
    expect(res.analysis.cadence?.everyNMessages).toBe(5);
    expect(res.analysis.extractor?.apiKey).toBe(SECRET_MASK);
    expect(res.secretMask).toBe(SECRET_MASK);
  });

  it("rejects an invalid block", async () => {
    await expect(
      putAnalysisSettings(ctx, { analysis: { cadence: { everyNMessages: 0 } } }),
    ).rejects.toThrow(/everyNMessages/);
  });
});

describe("offerSkillRoute (background job)", () => {
  /** A controllable generator: resolves its draft only when `release()` is called. */
  function deferredGenerator(draft: SkillDraft) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let lastContext: SkillGenContext | undefined;
    const generator: SkillGenerator = {
      async generate(_intent, context) {
        lastContext = context;
        await gate;
        return draft;
      },
    };
    return { generator, release: () => release(), context: () => lastContext };
  }

  function immediateGenerator(draft: SkillDraft): SkillGenerator {
    return { generate: async () => draft };
  }

  async function waitForOfferStatus(intent: string, want: string) {
    for (let i = 0; i < 200; i++) {
      const body = (await offerStatusRoute(ctx, intent)).body as { status: string };
      if (body.status === want) return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`offer status never reached ${want}`);
  }

  it("requires a non-empty intent", async () => {
    await expect(offerSkillRoute(ctx, { intent: "  " })).rejects.toThrow(/intent is required/);
  });

  it("starts a job and returns a draft via status when done", async () => {
    const draft: SkillDraft = {
      name: "grafana-dashboard",
      description: "Set up a Grafana dashboard with Prometheus",
      body: "# steps",
    };
    const start = await offerSkillRoute(
      ctx,
      { intent: "set up a grafana dashboard" },
      { generator: immediateGenerator(draft) },
    );
    expect(start.body).toMatchObject({ started: true, intent: "set up a grafana dashboard" });
    expect((start.body as { model: string }).model).toBeTruthy();

    const done = (await waitForOfferStatus("set up a grafana dashboard", "done")) as {
      status: string;
      draft?: SkillDraft;
    };
    expect(done.status).toBe("done");
    expect(done.draft?.name).toBe("grafana-dashboard");
  });

  it("reports alreadyRunning for a second call while in flight", async () => {
    const deferred = deferredGenerator({
      name: "x",
      description: "d",
      body: "b",
    });
    const first = await offerSkillRoute(
      ctx,
      { intent: "rig up a CI pipeline" },
      { generator: deferred.generator },
    );
    expect(first.body).toMatchObject({ started: true });
    expect((await offerStatusRoute(ctx, "rig up a CI pipeline")).body).toMatchObject({
      status: "running",
    });

    const second = await offerSkillRoute(
      ctx,
      { intent: "rig up a CI pipeline" },
      { generator: deferred.generator },
    );
    expect(second.body).toMatchObject({ started: false, alreadyRunning: true });

    deferred.release();
    await waitForOfferStatus("rig up a CI pipeline", "done");
  });

  it("passes a rich context built from session evidence + related intents", async () => {
    await seedSkill("tdd-workflow", "Write unit tests first then implement", ["write tests"]);
    await seedChat("sess-ctx", [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "set up a grafana dashboard" },
    ]);
    await runIntentsRoute(ctx, {});
    await waitForIdle();

    const deferred = deferredGenerator({ name: "g", description: "d", body: "b" });
    await offerSkillRoute(
      ctx,
      { intent: "set up a grafana dashboard" },
      { generator: deferred.generator },
    );
    // Give the async job a tick to invoke generate() and capture context.
    for (let i = 0; i < 100 && !deferred.context(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const context = deferred.context();
    deferred.release();
    await waitForOfferStatus("set up a grafana dashboard", "done");

    expect(context?.relatedIntents).toContain("write tests for the parser");
    expect(context?.existingSkillIds).toContain("tdd-workflow");
  });

  it("reports idle status when no job exists", async () => {
    const res = await offerStatusRoute(ctx, "never offered this");
    expect(res.body).toMatchObject({ status: "idle" });
  });

  it("lists offer jobs with hasDraft and no draft body", async () => {
    // A done job (has a draft).
    const draft: SkillDraft = { name: "done-skill", description: "d", body: "# steps" };
    await offerSkillRoute(
      ctx,
      { intent: "list-test done intent" },
      { generator: immediateGenerator(draft) },
    );
    await waitForOfferStatus("list-test done intent", "done");

    // An error job (no draft).
    const failing: SkillGenerator = {
      generate: async () => {
        throw new Error("boom");
      },
    };
    await offerSkillRoute(ctx, { intent: "list-test error intent" }, { generator: failing });
    await waitForOfferStatus("list-test error intent", "error");

    // A running job (no draft yet).
    const deferred = deferredGenerator({ name: "r", description: "d", body: "b" });
    await offerSkillRoute(
      ctx,
      { intent: "list-test running intent" },
      { generator: deferred.generator },
    );
    await waitForOfferStatus("list-test running intent", "running");

    const res = await listOfferJobsRoute(ctx);
    expect(res.status).toBe(200);
    const jobs = (res.body as { jobs: Array<Record<string, unknown>> }).jobs;
    const byIntent = Object.fromEntries(jobs.map((j) => [j.intent as string, j]));

    const done = byIntent["list-test done intent"];
    expect(done.status).toBe("done");
    expect(done.hasDraft).toBe(true);
    expect(done).not.toHaveProperty("draft");
    expect(typeof done.model).toBe("string");
    expect(typeof done.startedAt).toBe("string");

    const errored = byIntent["list-test error intent"];
    expect(errored.status).toBe("error");
    expect(errored.hasDraft).toBe(false);
    expect(errored.error).toBe("boom");
    expect(errored).not.toHaveProperty("draft");

    const running = byIntent["list-test running intent"];
    expect(running.status).toBe("running");
    expect(running.hasDraft).toBe(false);
    expect(running).not.toHaveProperty("draft");

    deferred.release();
    await waitForOfferStatus("list-test running intent", "done");
  });

  it("clears a finished job so it no longer surfaces", async () => {
    const intent = "clear-test intent";
    await offerSkillRoute(
      ctx,
      { intent },
      { generator: immediateGenerator({ name: "c", description: "d", body: "b" }) },
    );
    await waitForOfferStatus(intent, "done");

    const cleared = await clearOfferJobRoute(ctx, intent);
    expect(cleared.body).toMatchObject({ cleared: true });

    expect((await offerStatusRoute(ctx, intent)).body).toMatchObject({ status: "idle" });
    const jobs = (await listOfferJobsRoute(ctx)).body as { jobs: Array<{ intent: string }> };
    expect(jobs.jobs.some((j) => j.intent === intent)).toBe(false);
  });
});

describe("getObservabilityRoute", () => {
  it("returns an empty, zeroed summary before any run", async () => {
    const res = await getObservabilityRoute(ctx);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      runs: [],
      summary: { totalRuns: 0, lastRunAt: null, avgDurationMs: 0, avgGapsPerRun: 0 },
    });
  });

  it("returns runs + a computed summary after a run", async () => {
    await seedSkill("tdd-workflow", "Write unit tests first then implement", ["write tests"]);
    await seedChat("sess-1", [
      { role: "user", content: "write tests for the parser" },
      { role: "user", content: "set up a grafana dashboard" },
    ]);
    await runIntentsRoute(ctx, {});
    await waitForIdle();

    const res = (await getObservabilityRoute(ctx)).body as {
      runs: Array<{ runId: string }>;
      summary: { totalRuns: number; lastRunAt: string | null };
    };
    expect(res.runs.length).toBeGreaterThanOrEqual(1);
    expect(res.summary.totalRuns).toBe(res.runs.length);
    expect(res.summary.lastRunAt).not.toBeNull();
  });
});

describe("getChatsRoute + getChatRoute", () => {
  it("derives titles and counts, sorted by updatedAt DESC", async () => {
    await seedSkill("tdd-workflow", "Write unit tests first then implement", ["write tests"]);
    await seedChat("sess-old", [{ role: "user", content: "  first   request   here  " }], {
      updatedAt: "2026-01-01T00:00:00.000Z",
      cwd: "/repo/alpha",
    });
    await seedChat(
      "sess-new",
      [
        { role: "user", content: "write tests for the parser" },
        { role: "user", content: "set up a grafana dashboard" },
      ],
      { updatedAt: "2026-06-01T00:00:00.000Z", cwd: "/repo/beta" },
    );
    await runIntentsRoute(ctx, {});
    await waitForIdle();

    const res = (await getChatsRoute(ctx)).body as {
      chats: Array<{
        sessionId: string;
        title: string;
        turnCount: number;
        intentCount: number;
        analyzed: boolean;
      }>;
    };
    expect(res.chats.map((c) => c.sessionId)).toEqual(["sess-new", "sess-old"]);
    const old = res.chats.find((c) => c.sessionId === "sess-old");
    expect(old?.title).toBe("first request here");
    const fresh = res.chats.find((c) => c.sessionId === "sess-new");
    expect(fresh?.title).toBe("write tests for the parser");
    expect(fresh?.turnCount).toBe(2);
    expect(fresh?.analyzed).toBe(true);
    expect(fresh?.intentCount).toBeGreaterThanOrEqual(1);
  });

  it("falls back to cwd basename when no readable user turn", async () => {
    await seedChat("sess-empty", [{ role: "assistant", content: "hi" }], { cwd: "/repo/gamma" });
    const res = (await getChatsRoute(ctx)).body as {
      chats: Array<{ sessionId: string; title: string }>;
    };
    expect(res.chats.find((c) => c.sessionId === "sess-empty")?.title).toBe("gamma");
  });

  it("returns one chat with its transcript, 404 when unknown", async () => {
    await seedChat("sess-1", [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi" },
    ]);
    const res = (await getChatRoute(ctx, "sess-1")).body as {
      sessionId: string;
      title: string;
      turns: Array<{ role: string }>;
    };
    expect(res.sessionId).toBe("sess-1");
    expect(res.title).toBe("hello there");
    expect(res.turns).toHaveLength(2);

    const missing = await getChatRoute(ctx, "nope");
    expect(missing.status).toBe(404);
  });

  it("returns the total turn count and the full transcript when under the limit", async () => {
    await seedChat("sess-total", [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "again" },
    ]);
    const res = (await getChatRoute(ctx, "sess-total")).body as {
      turns: Array<{ role: string }>;
      total: number;
    };
    expect(res.total).toBe(3);
    expect(res.turns).toHaveLength(3);
  });

  it("paginates: returns only the last N turns and the correct total", async () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    await seedChat("sess-page", turns);

    const res = (await getChatRoute(ctx, "sess-page", 10)).body as {
      turns: Array<{ content: string }>;
      total: number;
    };
    expect(res.total).toBe(50);
    expect(res.turns).toHaveLength(10);
    // The last 10 turns (40..49), in order.
    expect(res.turns[0].content).toBe("turn 40");
    expect(res.turns[9].content).toBe("turn 49");
    expect(res.total).toBeGreaterThan(res.turns.length);
  });

  it("applies the default limit when omitted", async () => {
    const turns = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    await seedChat("sess-default", turns);

    const res = (await getChatRoute(ctx, "sess-default")).body as {
      turns: Array<{ content: string }>;
      total: number;
    };
    expect(res.total).toBe(80);
    // Default limit is 60.
    expect(res.turns).toHaveLength(60);
    expect(res.turns[0].content).toBe("turn 20");
  });

  it("treats a non-positive limit as the default", async () => {
    const turns = Array.from({ length: 80 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    await seedChat("sess-zero", turns);

    const res = (await getChatRoute(ctx, "sess-zero", 0)).body as {
      turns: Array<{ content: string }>;
    };
    expect(res.turns).toHaveLength(60);
  });
});

describe("deleteChatRoute", () => {
  it("removes turn file, state entry, session intents, and rebuilds the index", async () => {
    await seedSkill("tdd-workflow", "Write unit tests first then implement", ["write tests"]);
    await seedChat("sess-keep", [{ role: "user", content: "write tests for the parser" }]);
    await seedChat("sess-drop", [{ role: "user", content: "set up a grafana dashboard" }]);
    await runIntentsRoute(ctx, {});
    await waitForIdle();

    const del = await deleteChatRoute(ctx, "sess-drop");
    expect(del.body).toMatchObject({ deleted: "sess-drop" });

    // Chat list no longer includes the deleted session.
    const chats = (await getChatsRoute(ctx)).body as { chats: Array<{ sessionId: string }> };
    expect(chats.chats.map((c) => c.sessionId)).toEqual(["sess-keep"]);

    // Its turn file + per-session intents file are gone, so the rebuilt index drops it.
    const { readAllSessionIntents, rebuildIndex } = await import("@ratel-ai/mcp-core");
    const { intentsPaths, resolveRatelDir } = await import("@ratel-ai/mcp-core");
    const intentsDir = intentsPaths(resolveRatelDir(process.env, home)).intentsDir;
    const rebuilt = rebuildIndex(await readAllSessionIntents(nodeFs, intentsDir));
    expect(rebuilt.sessions.map((s) => s.sessionId)).toEqual(["sess-keep"]);
    expect(rebuilt.intents.map((i) => i.content)).toEqual(["write tests for the parser"]);

    // The turn file is unreadable now.
    const turnFile = join(ratelDir, "chat", "claude-code", "sess-drop.jsonl");
    expect(await nodeFs.read(turnFile)).toBeNull();
  });

  it("tolerates deleting an unknown session", async () => {
    const del = await deleteChatRoute(ctx, "ghost");
    expect(del.body).toMatchObject({ deleted: "ghost" });
  });
});
