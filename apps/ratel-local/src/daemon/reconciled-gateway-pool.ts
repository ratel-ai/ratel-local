import { type FSWatcher, watch as nodeWatch } from "node:fs";
import { dirname } from "node:path";
import type {
  AuthFlowOptions,
  AuthFlowResult,
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
  leases: number;
  closed: boolean;
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
    if ("runtimeRevision" in input) {
      const lease = await this.options.generations.acquire(input);
      return input.resolvedContext ? this.bindMonitorLease(lease, input.resolvedContext) : lease;
    }
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
    const lease = await this.options.generations.acquire(toGatewayGeneration(snapshot));
    return this.bindMonitorLease(lease, snapshot);
  }

  /** Publish the latest revision after a committed control-plane mutation. */
  async reconcileContext(context: RuntimeContextRef): Promise<ResolvedContextSnapshot> {
    return this.resolveAndPublish(context);
  }

  /**
   * Authenticate through the current shared generation so its catalog and every
   * subscribed MCP session observe the newly available tools immediately.
   */
  async authenticate(
    context: RuntimeContextRef,
    options: AuthFlowOptions = {},
  ): Promise<AuthFlowResult[]> {
    const lease = await this.acquireContext(context);
    try {
      return await lease.gateway.runAuthFlow(options);
    } finally {
      await lease.release();
    }
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
      const monitor = this.monitors.get(contextKey(context));
      if (this.watchEnabled && monitor) this.refreshMonitor(monitor, snapshot);
      return snapshot;
    } catch (error) {
      this.options.onInvalidSnapshot?.(context, error as Error);
      throw error;
    }
  }

  private bindMonitorLease(lease: GatewayLease, snapshot: ResolvedContextSnapshot): GatewayLease {
    if (!this.watchEnabled) return lease;
    const key = contextKey(snapshot.context);
    let monitor = this.monitors.get(key);
    if (!monitor) {
      monitor = {
        context: snapshot.context,
        snapshot,
        leases: 0,
        closed: false,
        watchers: [],
      };
      this.monitors.set(key, monitor);
      this.openWatchers(monitor);
    } else {
      this.refreshMonitor(monitor, snapshot);
    }
    monitor.leases += 1;
    let released = false;
    return {
      ...lease,
      release: async () => {
        if (released) return;
        released = true;
        monitor.leases = Math.max(0, monitor.leases - 1);
        if (monitor.leases === 0 && this.monitors.get(key) === monitor) {
          this.monitors.delete(key);
          this.closeMonitor(monitor);
        }
        await lease.release();
      },
    };
  }

  private refreshMonitor(monitor: ContextMonitor, snapshot: ResolvedContextSnapshot): void {
    if (monitor.closed || this.monitors.get(contextKey(monitor.context)) !== monitor) return;
    if (sameWatchInputs(monitor.snapshot, snapshot)) {
      monitor.snapshot = snapshot;
      return;
    }
    this.closeWatchers(monitor);
    monitor.snapshot = snapshot;
    this.openWatchers(monitor);
  }

  private openWatchers(monitor: ContextMonitor): void {
    if (monitor.closed || monitor.leases < 0) return;
    for (const path of watchPaths(monitor.snapshot)) {
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
    if (monitor.closed || monitor.pollTimer) return;
    monitor.pollTimer = setInterval(
      () => this.scheduleMonitor(monitor),
      Math.max(this.debounceMs, 100),
    );
    monitor.pollTimer.unref();
  }

  private scheduleMonitor(monitor: ContextMonitor): void {
    if (monitor.closed || this.monitors.get(contextKey(monitor.context)) !== monitor) return;
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
      if (monitor.closed || this.monitors.get(contextKey(monitor.context)) !== monitor) return;
      if (next.runtimeRevision !== monitor.snapshot.runtimeRevision) {
        this.options.onRevision?.(monitor.context, next.runtimeRevision);
      }
      this.refreshMonitor(monitor, next);
    } catch (error) {
      this.options.onInvalidSnapshot?.(monitor.context, error as Error);
      this.log(
        `[ratel] invalid snapshot for ${contextKey(monitor.context)}: ${(error as Error).message}`,
      );
    }
  }

  private closeMonitor(monitor: ContextMonitor): void {
    monitor.closed = true;
    this.closeWatchers(monitor);
  }

  private closeWatchers(monitor: ContextMonitor): void {
    if (monitor.timer) clearTimeout(monitor.timer);
    if (monitor.pollTimer) clearInterval(monitor.pollTimer);
    monitor.timer = undefined;
    monitor.pollTimer = undefined;
    monitor.dirty = false;
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
