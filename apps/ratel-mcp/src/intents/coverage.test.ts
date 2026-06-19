import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyIndex,
  intentsPaths,
  mergeIntoIndex,
  nodeJsonFs,
  readIntentsIndex,
  type SessionIntents,
  writeIntentsIndex,
} from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recomputeIntentCoverage } from "./coverage.js";

let home: string;
let intentsDir: string;
const prevRatelHome = process.env.RATEL_HOME;
const NOW = "2026-06-19T10:00:00.000Z";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ratel-cov-"));
  process.env.RATEL_HOME = join(home, ".ratel");
  intentsDir = intentsPaths(join(home, ".ratel")).intentsDir;
});

afterEach(async () => {
  if (prevRatelHome === undefined) delete process.env.RATEL_HOME;
  else process.env.RATEL_HOME = prevRatelHome;
  await rm(home, { recursive: true, force: true });
});

function sessionWith(content: string, coverage: SessionIntents["intents"][number]["coverage"]) {
  return {
    sessionId: "s1",
    host: "claude-code",
    analyzedAt: NOW,
    claims: [],
    intents: [{ content, coverage }],
  } satisfies SessionIntents;
}

async function seedSkill(name: string, description: string, tags: string[]) {
  const dir = join(home, ".ratel", "skills", name);
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

describe("recomputeIntentCoverage", () => {
  it("turns a gap into covered when a matching skill exists", async () => {
    await writeIntentsIndex(
      nodeJsonFs,
      intentsDir,
      mergeIntoIndex(
        emptyIndex(),
        sessionWith("write unit tests for the parser", { status: "gap" }),
        NOW,
      ),
    );
    await seedSkill("tdd-workflow", "Write unit tests first then implement", [
      "write tests",
      "tests",
      "testing",
    ]);

    await recomputeIntentCoverage({ homeDir: home }, nodeJsonFs);

    const index = await readIntentsIndex(nodeJsonFs, intentsDir);
    expect(index.intents[0].coverage.status).toBe("covered");
    expect(index.sessions[0].gapCount).toBe(0);
  });

  it("turns covered back into a gap when no skill matches (e.g. unmanaged)", async () => {
    await writeIntentsIndex(
      nodeJsonFs,
      intentsDir,
      mergeIntoIndex(
        emptyIndex(),
        sessionWith("provision a kubernetes cluster", {
          status: "covered",
          skills: [{ skillId: "k8s", score: 5 }],
        }),
        NOW,
      ),
    );
    // No skills on disk → nothing matches.
    await recomputeIntentCoverage({ homeDir: home }, nodeJsonFs);

    const index = await readIntentsIndex(nodeJsonFs, intentsDir);
    expect(index.intents[0].coverage.status).toBe("gap");
    expect(index.sessions[0].gapCount).toBe(1);
  });

  it("is a no-op on an empty index", async () => {
    await writeIntentsIndex(nodeJsonFs, intentsDir, emptyIndex());
    await recomputeIntentCoverage({ homeDir: home }, nodeJsonFs);
    expect((await readIntentsIndex(nodeJsonFs, intentsDir)).intents).toEqual([]);
  });
});
