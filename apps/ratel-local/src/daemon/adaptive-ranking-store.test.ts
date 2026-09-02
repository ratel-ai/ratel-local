import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@ratel-ai/ratel-local-core";
import { IntentGraph, ToolCatalog } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdaptiveRankingStore, adaptiveRankingGraphPath } from "./adaptive-ranking-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ratel-adaptive-ranking-"));
  temporaryDirectories.push(path);
  return path;
}

function graphJson(rev = 0): string {
  const wire = JSON.parse(new IntentGraph().toJson()) as Record<string, unknown>;
  wire.rev = rev;
  return JSON.stringify(wire);
}

async function teach(graph: IntentGraph): Promise<void> {
  const catalog = new ToolCatalog();
  await catalog.register([
    {
      id: "build_status",
      name: "build_status",
      description: "Inspect the current build status",
      inputSchema: {},
      outputSchema: {},
      execute: async () => "ok",
    },
  ]);
  catalog.experimentalEnableAdaptiveRanking(graph);
  catalog.search("is the build passing", 5);
  await catalog.invoke("build_status", {});
}

describe("AdaptiveRankingStore", () => {
  it("uses one graph per runtime context and stable scoped paths", async () => {
    const homeDir = await temporaryHome();
    const store = new AdaptiveRankingStore({ homeDir, flushIntervalMs: 60_000 });
    const projectAId = "prj_a" as ProjectId;
    const projectBId = "prj_b" as ProjectId;

    const global = await store.graphFor({ kind: "global" });
    const projectA = await store.graphFor({ kind: "project", projectId: projectAId });
    const projectAAgain = await store.graphFor({
      kind: "project",
      projectId: projectAId,
    });
    const projectB = await store.graphFor({ kind: "project", projectId: projectBId });

    expect(projectAAgain).toBe(projectA);
    expect(global).not.toBe(projectA);
    expect(projectA).not.toBe(projectB);
    expect(adaptiveRankingGraphPath(homeDir, { kind: "global" })).toBe(
      join(homeDir, ".ratel", "adaptive-ranking", "global.json"),
    );
    expect(adaptiveRankingGraphPath(homeDir, { kind: "project", projectId: projectAId })).toBe(
      join(homeDir, ".ratel", "adaptive-ranking", "projects", "prj_a.json"),
    );

    await store.shutdown();
  });

  it("restores a graph, periodically persists changes, and restricts file permissions", async () => {
    const homeDir = await temporaryHome();
    const context = { kind: "project", projectId: "prj_restore" as ProjectId } as const;
    const path = adaptiveRankingGraphPath(homeDir, context);
    await mkdir(join(homeDir, ".ratel", "adaptive-ranking", "projects"), { recursive: true });
    await writeFile(path, graphJson(4));

    const store = new AdaptiveRankingStore({ homeDir, flushIntervalMs: 10 });
    const graph = await store.graphFor(context);
    expect(graph.rev).toBe(4);

    await teach(graph);
    await vi.waitFor(
      async () => {
        expect(IntentGraph.fromJson(await readFile(path, "utf8")).rev).toBeGreaterThan(4);
      },
      { timeout: 2_000 },
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(homeDir, ".ratel", "adaptive-ranking"))).mode & 0o777).toBe(0o700);

    await store.shutdown();
  });

  it("falls back to an empty graph when the saved graph is invalid", async () => {
    const homeDir = await temporaryHome();
    const log = vi.fn();
    const path = adaptiveRankingGraphPath(homeDir, { kind: "global" });
    await mkdir(join(homeDir, ".ratel", "adaptive-ranking"), { recursive: true });
    await writeFile(path, "not-json");

    const store = new AdaptiveRankingStore({ homeDir, logger: log, flushIntervalMs: 60_000 });
    expect((await store.graphFor({ kind: "global" })).rev).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/ignored invalid adaptive ranking graph/i),
    );

    await store.shutdown();
  });

  it("does not overwrite a graph advanced by another writer", async () => {
    const homeDir = await temporaryHome();
    const log = vi.fn();
    const context = { kind: "global" } as const;
    const path = adaptiveRankingGraphPath(homeDir, context);
    await mkdir(join(homeDir, ".ratel", "adaptive-ranking"), { recursive: true });
    await writeFile(path, graphJson(1));

    const store = new AdaptiveRankingStore({ homeDir, logger: log, flushIntervalMs: 60_000 });
    const graph = await store.graphFor(context);
    await teach(graph);
    await writeFile(path, graphJson(graph.rev + 1));

    await store.flush();

    expect(IntentGraph.fromJson(await readFile(path, "utf8")).rev).toBe(graph.rev + 1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/newer adaptive ranking graph/i));
    await store.shutdown();
  });
});
