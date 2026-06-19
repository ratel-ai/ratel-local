import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFs, nodeJsonFs } from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ParsedArgs } from "../cli/args.js";
import type { HandlerCtx } from "../cli/handlers/types.js";
import { silentPromptAdapter } from "../cli/prompts.js";
import { SECRET_MASK } from "./analysis-settings.js";
import {
  clearIntentsRoute,
  deleteIntentRoute,
  getAnalysisSettings,
  getIntents,
  getSessionIntents,
  offerSkillRoute,
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

async function seedChat(sessionId: string, turns: Array<{ role: string; content: string }>) {
  const file = join(ratelDir, "chat", "claude-code", `${sessionId}.jsonl`);
  await nodeJsonFs.writeAtomic(file, `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`);
  await nodeJsonFs.writeAtomic(
    join(ratelDir, "chat", "state.json"),
    JSON.stringify({
      version: 1,
      sessions: { [sessionId]: { sessionId, host: "claude-code", newTurnCount: 99 } },
    }),
  );
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

  it("requires content", async () => {
    await expect(deleteIntentRoute(ctx, { content: "  " })).rejects.toThrow(/content is required/);
  });

  it("clears every intent", async () => {
    await seedAndRun();
    await clearIntentsRoute(ctx);
    const index = (await getIntents(ctx)).body as { intents: unknown[]; sessions: unknown[] };
    expect(index.intents).toEqual([]);
    expect(index.sessions).toEqual([]);
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

describe("offerSkillRoute", () => {
  it("requires a non-empty intent", async () => {
    await expect(offerSkillRoute(ctx, { intent: "  " })).rejects.toThrow(/intent is required/);
  });
});
