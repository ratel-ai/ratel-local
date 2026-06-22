import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeJsonFs } from "../../io.js";
import { appendRunLog, readRunLog, runsLogPath } from "./observability.js";
import type { RunLogEntry } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-runs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    runId: "r1",
    at: "2026-06-19T10:00:00.000Z",
    trigger: "manual",
    durationMs: 100,
    totalIntents: 2,
    totalGaps: 1,
    sessions: [
      {
        sessionId: "s1",
        ok: true,
        intents: 2,
        gaps: 1,
        turns: 8,
        latencyMs: 90,
        cacheHit: false,
      },
    ],
    ...overrides,
  };
}

describe("runsLogPath", () => {
  it("points at runs.jsonl under the intents dir", () => {
    expect(runsLogPath(dir)).toBe(join(dir, "runs.jsonl"));
  });
});

describe("appendRunLog + readRunLog", () => {
  it("round-trips an appended entry", async () => {
    await appendRunLog(nodeJsonFs, dir, entry());
    const read = await readRunLog(nodeJsonFs, dir);
    expect(read).toHaveLength(1);
    expect(read[0].runId).toBe("r1");
  });

  it("returns [] when no log exists", async () => {
    expect(await readRunLog(nodeJsonFs, dir)).toEqual([]);
  });

  it("returns entries newest-first", async () => {
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r1" }));
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r2" }));
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r3" }));
    const read = await readRunLog(nodeJsonFs, dir);
    expect(read.map((e) => e.runId)).toEqual(["r3", "r2", "r1"]);
  });

  it("caps reads to the requested limit", async () => {
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r1" }));
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r2" }));
    const read = await readRunLog(nodeJsonFs, dir, 1);
    expect(read.map((e) => e.runId)).toEqual(["r2"]);
  });

  it("keeps only the last 200 entries on the log", async () => {
    for (let i = 0; i < 205; i += 1) {
      await appendRunLog(nodeJsonFs, dir, entry({ runId: `r${i}` }));
    }
    const all = await readRunLog(nodeJsonFs, dir, 1000);
    expect(all).toHaveLength(200);
    // newest-first: most recent is r204, oldest retained is r5
    expect(all[0].runId).toBe("r204");
    expect(all[all.length - 1].runId).toBe("r5");
  });

  it("tolerates malformed lines on read", async () => {
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r1" }));
    await writeFile(runsLogPath(dir), `not-json\n${JSON.stringify(entry({ runId: "r2" }))}\n`);
    const read = await readRunLog(nodeJsonFs, dir);
    expect(read.map((e) => e.runId)).toEqual(["r2"]);
  });

  it("tolerates a malformed existing line when appending", async () => {
    await writeFile(runsLogPath(dir), "not-json\n");
    await appendRunLog(nodeJsonFs, dir, entry({ runId: "r1" }));
    const read = await readRunLog(nodeJsonFs, dir);
    expect(read.map((e) => e.runId)).toEqual(["r1"]);
  });
});
