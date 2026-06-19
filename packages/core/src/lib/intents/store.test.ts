import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeJsonFs } from "../../io.js";
import {
  emptyIndex,
  type IntentsIndex,
  mergeIntoIndex,
  normalizeIntentKey,
  readIntentsIndex,
  readSessionIntents,
  removeIntent,
  type SessionIntents,
  writeIntentsIndex,
  writeSessionIntents,
} from "./store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-intents-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function session(overrides: Partial<SessionIntents> = {}): SessionIntents {
  return {
    sessionId: "s1",
    host: "claude-code",
    analyzedAt: "2026-06-19T10:00:00.000Z",
    claims: [],
    intents: [
      { content: "Add OAuth login", coverage: { status: "gap" } },
      {
        content: "Write tests",
        coverage: { status: "covered", skills: [{ skillId: "tdd", score: 4.2 }] },
      },
    ],
    ...overrides,
  };
}

describe("normalizeIntentKey", () => {
  it("lowercases, collapses whitespace, and strips trailing punctuation", () => {
    expect(normalizeIntentKey("  Add   OAuth login!! ")).toBe("add oauth login");
    expect(normalizeIntentKey("Add OAuth login")).toBe(normalizeIntentKey("add oauth   login."));
  });
});

describe("mergeIntoIndex", () => {
  it("adds new intents and a session summary", () => {
    const merged = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    expect(merged.intents).toHaveLength(2);
    expect(merged.sessions).toEqual([
      {
        sessionId: "s1",
        host: "claude-code",
        cwd: undefined,
        analyzedAt: "2026-06-19T10:00:00.000Z",
        intentCount: 2,
        gapCount: 1,
      },
    ]);
  });

  it("de-dupes a repeated intent across sessions and refreshes coverage", () => {
    const first = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    const second = mergeIntoIndex(
      first,
      session({
        sessionId: "s2",
        analyzedAt: "2026-06-19T11:00:00.000Z",
        intents: [
          // same intent, now covered by a freshly-added skill
          {
            content: "add oauth login.",
            coverage: { status: "covered", skills: [{ skillId: "oauth", score: 5 }] },
          },
        ],
      }),
      "2026-06-19T11:00:00.000Z",
    );
    const oauth = second.intents.find((i) => normalizeIntentKey(i.content) === "add oauth login");
    expect(oauth?.sessions).toEqual(["s1", "s2"]);
    expect(oauth?.coverage).toEqual({
      status: "covered",
      skills: [{ skillId: "oauth", score: 5 }],
    });
    expect(oauth?.firstSeen).toBe("2026-06-19T10:00:00.000Z");
    expect(oauth?.lastSeen).toBe("2026-06-19T11:00:00.000Z");
  });

  it("replaces a session's intents on re-analysis instead of accumulating them", () => {
    const first = mergeIntoIndex(
      emptyIndex(),
      session({
        intents: [
          { content: "Add OAuth login", coverage: { status: "gap" } },
          { content: "Old reworded intent", coverage: { status: "gap" } },
        ],
      }),
      "2026-06-19T10:00:00.000Z",
    );
    // Re-run of the SAME session returns one shared intent + one new phrasing.
    const second = mergeIntoIndex(
      first,
      session({
        analyzedAt: "2026-06-19T11:00:00.000Z",
        intents: [
          { content: "Add OAuth login", coverage: { status: "gap" } },
          { content: "Newly phrased intent", coverage: { status: "gap" } },
        ],
      }),
      "2026-06-19T11:00:00.000Z",
    );
    const contents = second.intents.map((i) => i.content).sort();
    expect(contents).toEqual(["Add OAuth login", "Newly phrased intent"]);
    // The stale phrasing from the first run is gone; no accumulation.
    expect(contents).not.toContain("Old reworded intent");
    // firstSeen is preserved for the recurring intent.
    const oauth = second.intents.find((i) => i.content === "Add OAuth login");
    expect(oauth?.firstSeen).toBe("2026-06-19T10:00:00.000Z");
  });

  it("keeps another session's intents when one session is re-analyzed", () => {
    const withTwo = mergeIntoIndex(
      mergeIntoIndex(emptyIndex(), session({ sessionId: "s1" }), "2026-06-19T10:00:00.000Z"),
      session({
        sessionId: "s2",
        intents: [{ content: "s2-only intent", coverage: { status: "gap" } }],
      }),
      "2026-06-19T10:30:00.000Z",
    );
    // Re-analyze s1 with no intents; s2's intent must survive.
    const after = mergeIntoIndex(
      withTwo,
      session({ sessionId: "s1", intents: [] }),
      "2026-06-19T11:00:00.000Z",
    );
    expect(after.intents.map((i) => i.content)).toContain("s2-only intent");
  });

  it("upserts the session summary instead of duplicating it", () => {
    const first = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    const reanalyzed = mergeIntoIndex(
      first,
      session({ analyzedAt: "2026-06-19T12:00:00.000Z", intents: [] }),
      "2026-06-19T12:00:00.000Z",
    );
    expect(reanalyzed.sessions).toHaveLength(1);
    expect(reanalyzed.sessions[0].analyzedAt).toBe("2026-06-19T12:00:00.000Z");
  });
});

describe("removeIntent", () => {
  it("removes a matching intent (normalized) and updates the session counts", () => {
    const index = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    expect(index.intents).toHaveLength(2);
    const after = removeIntent(index, "  add OAUTH login!! ");
    expect(after.intents.map((i) => i.content)).toEqual(["Write tests"]);
    expect(after.sessions[0]).toMatchObject({ intentCount: 1, gapCount: 0 });
  });

  it("drops a session whose last intent was removed", () => {
    const index = mergeIntoIndex(
      emptyIndex(),
      session({ intents: [{ content: "only intent", coverage: { status: "gap" } }] }),
      "2026-06-19T10:00:00.000Z",
    );
    const after = removeIntent(index, "only intent");
    expect(after.intents).toHaveLength(0);
    expect(after.sessions).toHaveLength(0);
  });

  it("is a no-op for an unknown intent", () => {
    const index = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    expect(removeIntent(index, "never said this").intents).toHaveLength(2);
  });
});

describe("index + session persistence", () => {
  it("round-trips the index", async () => {
    const index: IntentsIndex = mergeIntoIndex(emptyIndex(), session(), "2026-06-19T10:00:00.000Z");
    await writeIntentsIndex(nodeJsonFs, dir, index);
    const read = await readIntentsIndex(nodeJsonFs, dir);
    expect(read.intents).toHaveLength(2);
  });

  it("returns an empty index when none exists", async () => {
    expect(await readIntentsIndex(nodeJsonFs, dir)).toEqual(emptyIndex());
  });

  it("round-trips a session file", async () => {
    await writeSessionIntents(nodeJsonFs, dir, session());
    const read = await readSessionIntents(nodeJsonFs, dir, "s1");
    expect(read?.intents).toHaveLength(2);
  });

  it("returns null for a missing session file", async () => {
    expect(await readSessionIntents(nodeJsonFs, dir, "missing")).toBeNull();
  });
});
