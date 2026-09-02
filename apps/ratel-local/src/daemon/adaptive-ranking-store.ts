import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeContextRef } from "@ratel-ai/ratel-local-core";
import { IntentGraph } from "@ratel-ai/sdk";

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

interface StoredGraph {
  graph: IntentGraph;
  path: string;
  persistedRev: number;
  conflicted: boolean;
}

export interface AdaptiveRankingStoreOptions {
  homeDir: string;
  logger?: (message: string) => void;
  flushIntervalMs?: number;
}

export function adaptiveRankingGraphPath(homeDir: string, context: RuntimeContextRef): string {
  const root = join(homeDir, ".ratel", "adaptive-ranking");
  return context.kind === "global"
    ? join(root, "global.json")
    : join(root, "projects", `${encodeURIComponent(context.projectId)}.json`);
}

/** Owns the daemon's context-scoped, in-memory intent graphs and their persistence. */
export class AdaptiveRankingStore {
  private readonly entries = new Map<string, Promise<StoredGraph>>();
  private readonly logger: (message: string) => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private flushInFlight?: Promise<void>;
  private stopped = false;

  constructor(private readonly options: AdaptiveRankingStoreOptions) {
    this.logger = options.logger ?? ((message) => console.error(message));
    this.timer = setInterval(() => {
      void this.flush().catch((error) => {
        this.logger(`[ratel] failed to persist adaptive ranking graphs: ${errorMessage(error)}`);
      });
    }, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async graphFor(context: RuntimeContextRef): Promise<IntentGraph> {
    if (this.stopped) throw new Error("adaptive ranking store is shut down");
    const key = context.kind === "global" ? "global" : `project:${context.projectId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.load(context);
      this.entries.set(key, entry);
    }
    return (await entry).graph;
  }

  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    const run = this.flushEntries().finally(() => {
      if (this.flushInFlight === run) this.flushInFlight = undefined;
    });
    this.flushInFlight = run;
    return run;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.flush();
  }

  private async load(context: RuntimeContextRef): Promise<StoredGraph> {
    const path = adaptiveRankingGraphPath(this.options.homeDir, context);
    try {
      const graph = IntentGraph.fromJson(await readFile(path, "utf8"));
      return { graph, path, persistedRev: graph.rev, conflicted: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger(
          `[ratel] ignored invalid adaptive ranking graph at ${path}: ${errorMessage(error)}`,
        );
      }
      return { graph: new IntentGraph(), path, persistedRev: 0, conflicted: false };
    }
  }

  private async flushEntries(): Promise<void> {
    const entries = await Promise.all(this.entries.values());
    const results = await Promise.allSettled(entries.map((entry) => this.persist(entry)));
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger(
          `[ratel] failed to persist adaptive ranking graph: ${errorMessage(result.reason)}`,
        );
      }
    }
  }

  private async persist(entry: StoredGraph): Promise<void> {
    if (entry.conflicted || entry.graph.rev === entry.persistedRev) return;

    const diskRev = await readGraphRevision(entry.path);
    if (diskRev !== undefined && diskRev > entry.persistedRev) {
      entry.conflicted = true;
      this.logger(
        `[ratel] found a newer adaptive ranking graph at ${entry.path}; keeping it and skipping the stale in-memory writer`,
      );
      return;
    }

    const snapshot = entry.graph.toJson();
    const snapshotRev = graphRevision(snapshot);
    const directory = dirname(entry.path);
    const storageRoot = join(this.options.homeDir, ".ratel", "adaptive-ranking");
    await mkdir(storageRoot, { recursive: true, mode: 0o700 });
    await chmod(storageRoot, 0o700);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${entry.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${snapshot}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, entry.path);
      await chmod(entry.path, 0o600);
      entry.persistedRev = snapshotRev;
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

async function readGraphRevision(path: string): Promise<number | undefined> {
  try {
    return graphRevision(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function graphRevision(json: string): number {
  return IntentGraph.fromJson(json).rev;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
