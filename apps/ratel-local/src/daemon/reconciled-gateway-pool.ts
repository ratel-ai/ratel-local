import { type FSWatcher, watch as nodeWatch } from "node:fs";
import { dirname } from "node:path";
import type {
  ContextSnapshotResolver,
  ProjectAdmissionLock,
  ProjectRegistry,
  ResolvedContextSnapshot,
  RuntimeContextRef,
  RuntimeRevision,
} from "@ratel-ai/ratel-local-core";
import type { DaemonRequestScope } from "./access.js";
import type {
  GatewayLease,
  ResolvedGatewaySnapshot,
  ScopedGatewayPool,
  ScopedGatewayPoolStats,
} from "./scoped-gateway-pool.js";

export interface ReconciledGatewayPoolOptions {
  generations: ScopedGatewayPool;
  registry: ProjectRegistry;
  resolver: ContextSnapshotResolver;
  onRevision?: (context: RuntimeContextRef, revision: RuntimeRevision) => void;
  onInvalidSnapshot?: (context: RuntimeContextRef, error: Error) => void;
  log?: (message: string) => void;
  watch?: boolean;
  debounceMs?: number;
  admissionLock?: ProjectAdmissionLock;
}

interface ContextMonitor {
  context: RuntimeContextRef;
  snapshot: ResolvedContextSnapshot;
  watchers: FSWatcher[];
  timer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  reconciling?: Promise<void>;
  dirty?: boolean;
}

/**
 * Admission/control-plane layer in front of the generational data-plane pool.
 * Connector roots are canonicalized and registered once, while every acquire
 * resolves disk state again before choosing a `(context, runtimeRevision)` generation.
 */
export class ReconciledGatewayPool implements ScopedGatewayPool {
  private readonly monitors = new Map<string, ContextMonitor>();
  private readonly watchEnabled: boolean;
  private readonly debounceMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: ReconciledGatewayPoolOptions) {
    this.watchEnabled = options.watch ?? true;
    this.debounceMs = options.debounceMs ?? 200;
    this.log = options.log ?? (() => {});
  }

  async acquire(input: ResolvedGatewaySnapshot | DaemonRequestScope): Promise<GatewayLease> {
    if ("runtimeRevision" in input) return this.options.generations.acquire(input);
    if (input.kind === "user") return this.acquireContext({ kind: "global" });
    const acquireProject = async () => {
      const project = await this.options.registry.registerRoot(input.projectRoot);
      return this.acquireContext({ kind: "project" as const, projectId: project.id });
    };
    return this.options.admissionLock
      ? this.options.admissionLock.run(acquireProject)
      : acquireProject();
  }

  async acquireContext(context: RuntimeContextRef): Promise<GatewayLease> {
    const snapshot = await this.resolveAndPublish(context);
    return this.options.generations.acquire(toGatewayGeneration(snapshot));
  }

  /** Publish the latest revision after a committed control-plane mutation. */
  async reconcileContext(context: RuntimeContextRef): Promise<ResolvedContextSnapshot> {
    return this.resolveAndPublish(context);
  }

  stats(): ScopedGatewayPoolStats {
    return this.options.generations.stats();
  }

  async shutdown(): Promise<void> {
    for (const monitor of this.monitors.values()) this.closeMonitor(monitor);
    this.monitors.clear();
    await this.options.generations.shutdown();
  }

  private async resolveAndPublish(context: RuntimeContextRef): Promise<ResolvedContextSnapshot> {
    try {
      const snapshot = await this.options.resolver.resolve(context);
      this.options.onRevision?.(context, snapshot.runtimeRevision);
      if (this.watchEnabled) this.installMonitor(snapshot);
      return snapshot;
    } catch (error) {
      this.options.onInvalidSnapshot?.(context, error as Error);
      throw error;
    }
  }

  private installMonitor(snapshot: ResolvedContextSnapshot): void {
    const key = contextKey(snapshot.context);
    const existing = this.monitors.get(key);
    if (existing && sameWatchInputs(existing.snapshot, snapshot)) {
      existing.snapshot = snapshot;
      return;
    }
    if (existing) this.closeMonitor(existing);

    const monitor: ContextMonitor = {
      context: snapshot.context,
      snapshot,
      watchers: [],
    };
    this.monitors.set(key, monitor);
    for (const path of watchPaths(snapshot)) {
      try {
        const watcher = nodeWatch(path, { persistent: false }, () => this.scheduleMonitor(monitor));
        watcher.on("error", (error) => {
          this.log(`[ratel] watcher failed for ${path}: ${error.message}`);
          watcher.close();
          this.ensurePolling(monitor);
        });
        monitor.watchers.push(watcher);
      } catch (error) {
        this.log(`[ratel] could not watch ${path}: ${(error as Error).message}`);
        this.ensurePolling(monitor);
      }
    }
  }

  private ensurePolling(monitor: ContextMonitor): void {
    if (monitor.pollTimer) return;
    monitor.pollTimer = setInterval(
      () => this.scheduleMonitor(monitor),
      Math.max(this.debounceMs, 100),
    );
    monitor.pollTimer.unref();
  }

  private scheduleMonitor(monitor: ContextMonitor): void {
    if (monitor.timer) clearTimeout(monitor.timer);
    monitor.timer = setTimeout(() => {
      monitor.timer = undefined;
      if (monitor.reconciling) {
        monitor.dirty = true;
        return;
      }
      monitor.reconciling = this.reconcileMonitor(monitor).finally(() => {
        monitor.reconciling = undefined;
        if (monitor.dirty && this.monitors.get(contextKey(monitor.context)) === monitor) {
          monitor.dirty = false;
          this.scheduleMonitor(monitor);
        }
      });
    }, this.debounceMs);
  }

  private async reconcileMonitor(monitor: ContextMonitor): Promise<void> {
    try {
      const next = await this.options.resolver.resolve(monitor.context);
      if (next.runtimeRevision !== monitor.snapshot.runtimeRevision) {
        this.options.onRevision?.(monitor.context, next.runtimeRevision);
      }
      this.installMonitor(next);
    } catch (error) {
      this.options.onInvalidSnapshot?.(monitor.context, error as Error);
      this.log(
        `[ratel] invalid snapshot for ${contextKey(monitor.context)}: ${(error as Error).message}`,
      );
    }
  }

  private closeMonitor(monitor: ContextMonitor): void {
    if (monitor.timer) clearTimeout(monitor.timer);
    if (monitor.pollTimer) clearInterval(monitor.pollTimer);
    for (const watcher of monitor.watchers) watcher.close();
    monitor.watchers = [];
  }
}

function toGatewayGeneration(snapshot: ResolvedContextSnapshot): ResolvedGatewaySnapshot {
  if (snapshot.context.kind === "global") {
    return {
      kind: "global",
      contextKey: "global",
      runtimeRevision: snapshot.runtimeRevision,
      resolvedContext: snapshot,
    };
  }
  if (!snapshot.projectRoot) {
    throw new Error(`project snapshot ${snapshot.context.projectId} has no project root`);
  }
  return {
    kind: "project",
    projectId: snapshot.context.projectId,
    projectRoot: snapshot.projectRoot,
    contextKey: `project:${snapshot.context.projectId}`,
    runtimeRevision: snapshot.runtimeRevision,
    resolvedContext: snapshot,
  };
}

function contextKey(context: RuntimeContextRef): string {
  return context.kind === "global" ? "global" : `project:${context.projectId}`;
}

function sameWatchInputs(a: ResolvedContextSnapshot, b: ResolvedContextSnapshot): boolean {
  return JSON.stringify(watchPaths(a)) === JSON.stringify(watchPaths(b));
}

function watchPaths(snapshot: ResolvedContextSnapshot): string[] {
  return Array.from(
    new Set(
      snapshot.watchInputs
        .map((input) => (input.kind === "directory" ? input.path : dirname(input.path)))
        .sort(),
    ),
  );
}
