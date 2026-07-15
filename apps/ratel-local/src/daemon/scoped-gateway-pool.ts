import {
  type GatewayHandle,
  projectIdFromCanonicalRoot,
  type ResolvedContextSnapshot,
  type RuntimeContextRef,
} from "@ratel-ai/ratel-local-core";
import type { DaemonRequestScope } from "./access.js";

type ListChangedListener = () => void | Promise<void>;

export interface GatewayGenerationIdentity {
  readonly contextKey: string;
  readonly runtimeRevision: string;
}

export type GatewayContext = RuntimeContextRef;

export type ResolvedGatewaySnapshot =
  | ({
      readonly kind: "global";
      readonly resolvedContext?: ResolvedContextSnapshot;
    } & GatewayGenerationIdentity)
  | ({
      readonly kind: "project";
      readonly projectId: Extract<RuntimeContextRef, { kind: "project" }>["projectId"];
      readonly projectRoot: string;
      readonly resolvedContext?: ResolvedContextSnapshot;
    } & GatewayGenerationIdentity);

export interface GatewayLease {
  gateway: GatewayHandle;
  context: GatewayContext;
  projectRoot?: string;
  contextKey: string;
  runtimeRevision: string;
  /** @deprecated Use contextKey. */
  scopeKey: string;
  release(): Promise<void>;
  subscribeListChanged(listener: ListChangedListener): () => void;
}

export interface GatewayGenerationStats extends GatewayGenerationIdentity {
  context: GatewayContext;
  projectRoot?: string;
  activeLeaseCount: number;
  upstreamCount: number;
}

export interface ScopedGatewayPoolStats {
  activeGatewayCount: number;
  activeUserGatewayCount: number;
  activeProjectGatewayCount: number;
  upstreamCount: number;
  generations: GatewayGenerationStats[];
}

export interface ScopedGatewayPool {
  acquire(snapshot: ResolvedGatewaySnapshot | DaemonRequestScope): Promise<GatewayLease>;
  stats(): ScopedGatewayPoolStats;
  shutdown(): Promise<void>;
}

interface PoolEntry {
  gateway: GatewayHandle;
  refs: number;
  listeners: Set<ListChangedListener>;
  closed: boolean;
}

interface PoolRecord {
  snapshot: ResolvedGatewaySnapshot;
  promise: Promise<PoolEntry>;
  entry?: PoolEntry;
}

export class InMemoryScopedGatewayPool implements ScopedGatewayPool {
  private readonly records = new Map<string, PoolRecord>();
  private shuttingDown = false;

  constructor(
    private readonly build: (snapshot: ResolvedGatewaySnapshot) => Promise<GatewayHandle>,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async acquire(input: ResolvedGatewaySnapshot | DaemonRequestScope): Promise<GatewayLease> {
    if (this.shuttingDown) throw new Error("gateway pool is shutting down");
    const snapshot = resolvedGatewaySnapshot(input);
    const key = gatewayGenerationKey(snapshot);
    let record: PoolRecord;
    let entry: PoolEntry;
    for (;;) {
      const existing = this.records.get(key);
      if (existing) {
        record = existing;
      } else {
        const next: PoolRecord = {
          snapshot,
          promise: Promise.resolve(undefined as never),
        };
        next.promise = this.buildEntry(snapshot, key, next);
        record = next;
        this.records.set(key, record);
      }

      entry = await record.promise;
      if (!entry.closed) break;
      if (this.shuttingDown) throw new Error("gateway pool is shutting down");
      if (this.records.get(key) === record) this.records.delete(key);
      // The previous final lease may have closed the generation while this
      // acquire was awaiting its promise. Retry against a fresh generation.
    }
    entry.refs += 1;
    let released = false;

    return {
      gateway: entry.gateway,
      context: gatewayContext(snapshot),
      ...(snapshot.kind === "project" ? { projectRoot: snapshot.projectRoot } : {}),
      contextKey: snapshot.contextKey,
      runtimeRevision: snapshot.runtimeRevision,
      scopeKey: snapshot.contextKey,
      subscribeListChanged: (listener) => {
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
      release: async () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs > 0 || entry.closed) return;
        entry.closed = true;
        if (this.records.get(key) === record) this.records.delete(key);
        entry.gateway.setListChangedNotifier(undefined);
        await entry.gateway.close();
      },
    };
  }

  stats(): ScopedGatewayPoolStats {
    const active = Array.from(this.records.values()).filter(
      (record): record is PoolRecord & { entry: PoolEntry } =>
        record.entry !== undefined && !record.entry.closed,
    );
    const generations = active.map(
      (record): GatewayGenerationStats => ({
        context: gatewayContext(record.snapshot),
        ...(record.snapshot.kind === "project" ? { projectRoot: record.snapshot.projectRoot } : {}),
        contextKey: record.snapshot.contextKey,
        runtimeRevision: record.snapshot.runtimeRevision,
        activeLeaseCount: record.entry.refs,
        upstreamCount: record.entry.gateway.upstreamServers.length,
      }),
    );
    return {
      activeGatewayCount: active.length,
      activeUserGatewayCount: active.filter((record) => record.snapshot.kind === "global").length,
      activeProjectGatewayCount: active.filter((record) => record.snapshot.kind === "project")
        .length,
      upstreamCount: generations.reduce((sum, generation) => sum + generation.upstreamCount, 0),
      generations,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const records = Array.from(this.records.values());
    this.records.clear();
    const entries = await Promise.allSettled(records.map((record) => record.promise));
    await Promise.allSettled(
      entries.flatMap((result) => {
        if (result.status === "rejected" || result.value.closed) return [];
        result.value.closed = true;
        result.value.gateway.setListChangedNotifier(undefined);
        return [result.value.gateway.close()];
      }),
    );
  }

  private async buildEntry(
    snapshot: ResolvedGatewaySnapshot,
    key: string,
    record: PoolRecord,
  ): Promise<PoolEntry> {
    try {
      const gateway = await this.build(snapshot);
      const entry: PoolEntry = {
        gateway,
        refs: 0,
        listeners: new Set(),
        closed: false,
      };
      gateway.setListChangedNotifier(async () => {
        const results = await Promise.allSettled(
          Array.from(entry.listeners).map((listener) => listener()),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            this.log(
              `[ratel] failed to notify scope ${key}: ${(result.reason as Error)?.message ?? result.reason}`,
            );
          }
        }
      });
      record.entry = entry;
      return entry;
    } catch (err) {
      if (this.records.get(key) === record) this.records.delete(key);
      throw err;
    }
  }
}

export function gatewayScopeKey(scope: GatewayContext): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectId}`;
}

function gatewayGenerationKey(snapshot: ResolvedGatewaySnapshot): string {
  return JSON.stringify([snapshot.contextKey, snapshot.runtimeRevision]);
}

function resolvedGatewaySnapshot(
  input: ResolvedGatewaySnapshot | DaemonRequestScope,
): ResolvedGatewaySnapshot {
  if ("contextKey" in input && "runtimeRevision" in input) return input;
  if (input.kind === "user") {
    return { kind: "global", contextKey: "global", runtimeRevision: "legacy" };
  }
  const projectId = projectIdFromCanonicalRoot(input.projectRoot);
  return {
    kind: "project",
    projectId,
    projectRoot: input.projectRoot,
    contextKey: `project:${projectId}`,
    runtimeRevision: "legacy",
  };
}

function gatewayContext(snapshot: ResolvedGatewaySnapshot): GatewayContext {
  return snapshot.kind === "global"
    ? { kind: "global" }
    : { kind: "project", projectId: snapshot.projectId };
}
