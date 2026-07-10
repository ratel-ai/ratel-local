import type { GatewayHandle } from "@ratel-ai/ratel-local-core";
import type { DaemonRequestScope } from "./access.js";

type ListChangedListener = () => void | Promise<void>;

export interface GatewayLease {
  gateway: GatewayHandle;
  scopeKey: string;
  release(): Promise<void>;
  subscribeListChanged(listener: ListChangedListener): () => void;
}

export interface ScopedGatewayPoolStats {
  activeGatewayCount: number;
  activeUserGatewayCount: number;
  activeProjectGatewayCount: number;
  upstreamCount: number;
}

export interface ScopedGatewayPool {
  acquire(scope: DaemonRequestScope): Promise<GatewayLease>;
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
  scope: DaemonRequestScope;
  promise: Promise<PoolEntry>;
  entry?: PoolEntry;
}

export class InMemoryScopedGatewayPool implements ScopedGatewayPool {
  private readonly records = new Map<string, PoolRecord>();
  private shuttingDown = false;

  constructor(
    private readonly build: (scope: DaemonRequestScope) => Promise<GatewayHandle>,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async acquire(scope: DaemonRequestScope): Promise<GatewayLease> {
    if (this.shuttingDown) throw new Error("gateway pool is shutting down");
    const key = gatewayScopeKey(scope);
    let record = this.records.get(key);
    if (!record) {
      const next: PoolRecord = {
        scope,
        promise: Promise.resolve(undefined as never),
      };
      next.promise = this.buildEntry(scope, key, next);
      record = next;
      this.records.set(key, record);
    }

    const entry = await record.promise;
    if (entry.closed) throw new Error(`gateway scope ${key} is closed`);
    entry.refs += 1;
    let released = false;

    return {
      gateway: entry.gateway,
      scopeKey: key,
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
    return {
      activeGatewayCount: active.length,
      activeUserGatewayCount: active.filter((record) => record.scope.kind === "user").length,
      activeProjectGatewayCount: active.filter((record) => record.scope.kind === "project").length,
      upstreamCount: active.reduce(
        (sum, record) => sum + record.entry.gateway.upstreamServers.length,
        0,
      ),
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
    scope: DaemonRequestScope,
    key: string,
    record: PoolRecord,
  ): Promise<PoolEntry> {
    try {
      const gateway = await this.build(scope);
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

export function gatewayScopeKey(scope: DaemonRequestScope): string {
  return scope.kind === "user" ? "user" : `project:${scope.projectRoot}`;
}
