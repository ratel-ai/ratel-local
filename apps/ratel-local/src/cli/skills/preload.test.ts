import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadNudged,
  parseHookInput,
  preloadStateDir,
  recordNudged,
  runPreloadHook,
} from "./preload.js";
import type { Suggestion } from "./suggest.js";

const FRONTEND: Suggestion = {
  skillId: "frontend-patterns",
  description: "React/Next patterns",
  score: 5,
};

function memoryState() {
  const store = new Map<string, Set<string>>();
  return {
    loadNudged: async (sid: string) => new Set(store.get(sid) ?? []),
    recordNudged: async (sid: string, ids: string[]) => {
      const set = store.get(sid) ?? new Set<string>();
      for (const id of ids) set.add(id);
      store.set(sid, set);
    },
  };
}

describe("parseHookInput", () => {
  it("extracts the fields we use and tolerates junk", () => {
    expect(parseHookInput('{"prompt":"hi","cwd":"/p","session_id":"s"}')).toEqual({
      prompt: "hi",
      cwd: "/p",
      session_id: "s",
    });
    expect(parseHookInput("not json")).toEqual({});
  });
});

describe("runPreloadHook", () => {
  it("injects a pointer naming the skill id and get_skill_content", async () => {
    const out = await runPreloadHook(
      { prompt: "build a dashboard", session_id: "s1" },
      { suggest: async () => [FRONTEND], ...memoryState() },
    );
    expect(out).toContain("frontend-patterns");
    expect(out).toContain('get_skill_content("frontend-patterns")');
  });

  it("returns null when nothing matches", async () => {
    const out = await runPreloadHook(
      { prompt: "x", session_id: "s1" },
      { suggest: async () => [], ...memoryState() },
    );
    expect(out).toBeNull();
  });

  it("returns null for an empty prompt without calling suggest", async () => {
    let called = false;
    const out = await runPreloadHook(
      { prompt: "   ", session_id: "s1" },
      {
        suggest: async () => {
          called = true;
          return [FRONTEND];
        },
        ...memoryState(),
      },
    );
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  it("de-dupes within a session — same skill is nudged only once", async () => {
    const state = memoryState();
    const deps = { suggest: async () => [FRONTEND], ...state };
    const first = await runPreloadHook({ prompt: "a", session_id: "s1" }, deps);
    const second = await runPreloadHook({ prompt: "b", session_id: "s1" }, deps);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    // a different session is nudged independently
    const other = await runPreloadHook({ prompt: "a", session_id: "s2" }, deps);
    expect(other).not.toBeNull();
  });
});

describe("dedup state persistence", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ratel-preload-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("round-trips nudged ids through the state file", async () => {
    const dir = preloadStateDir(home);
    expect(await loadNudged(dir, "s1")).toEqual(new Set());
    await recordNudged(dir, "s1", ["a", "b"]);
    await recordNudged(dir, "s1", ["b", "c"]);
    expect(await loadNudged(dir, "s1")).toEqual(new Set(["a", "b", "c"]));
  });
});
