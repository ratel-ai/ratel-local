import { type GatewayHandle, projectIdFromCanonicalRoot } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryScopedGatewayPool, type ResolvedGatewaySnapshot } from "./scoped-gateway-pool.js";

const REPO_ID = projectIdFromCanonicalRoot("/repo");

function gateway(name: string): GatewayHandle {
  return {
    catalog: { name } as never,
    skillCatalog: {} as never,
    upstreamServers: [{ name, toolCount: 1 }],
    close: vi.fn(async () => {}),
    runAuthFlow: vi.fn(async () => []),
    setListChangedNotifier: vi.fn(),
  };
}

describe("InMemoryScopedGatewayPool", () => {
  it("shares a gateway for one resolved generation and exposes its identity", async () => {
    const built: ResolvedGatewaySnapshot[] = [];
    const pool = new InMemoryScopedGatewayPool(async (snapshot) => {
      built.push(snapshot);
      return gateway(snapshot.runtimeRevision);
    });
    const snapshot = {
      kind: "project",
      projectId: REPO_ID,
      projectRoot: "/repo",
      contextKey: `project:${REPO_ID}`,
      runtimeRevision: "rev-1",
    } as const;

    const one = await pool.acquire(snapshot);
    const two = await pool.acquire({ ...snapshot });

    expect(built).toEqual([snapshot]);
    expect(one.gateway).toBe(two.gateway);
    expect(one.context).toEqual({ kind: "project", projectId: REPO_ID });
    expect(one.projectRoot).toBe("/repo");
    expect(one.contextKey).toBe(`project:${REPO_ID}`);
    expect(one.runtimeRevision).toBe("rev-1");
  });

  it("keeps old and new revisions of one context alive independently", async () => {
    const pool = new InMemoryScopedGatewayPool(async (snapshot) =>
      gateway(snapshot.runtimeRevision),
    );
    const context = {
      kind: "project",
      projectId: REPO_ID,
      projectRoot: "/repo",
      contextKey: `project:${REPO_ID}`,
    } as const;

    const oldGeneration = await pool.acquire({ ...context, runtimeRevision: "rev-1" });
    const newGeneration = await pool.acquire({ ...context, runtimeRevision: "rev-2" });

    expect(oldGeneration.gateway).not.toBe(newGeneration.gateway);
    await newGeneration.release();
    expect(newGeneration.gateway.close).toHaveBeenCalledOnce();
    expect(oldGeneration.gateway.close).not.toHaveBeenCalled();
    await oldGeneration.release();
    expect(oldGeneration.gateway.close).toHaveBeenCalledOnce();
  });

  it("reports the context, revision, and leases for every active generation", async () => {
    const pool = new InMemoryScopedGatewayPool(async (snapshot) =>
      gateway(snapshot.runtimeRevision),
    );
    const context = {
      kind: "project",
      projectId: REPO_ID,
      projectRoot: "/repo",
      contextKey: `project:${REPO_ID}`,
    } as const;

    await pool.acquire({ ...context, runtimeRevision: "rev-1" });
    await pool.acquire({ ...context, runtimeRevision: "rev-1" });
    await pool.acquire({ ...context, runtimeRevision: "rev-2" });

    expect(pool.stats().generations).toEqual([
      {
        context: { kind: "project", projectId: REPO_ID },
        projectRoot: "/repo",
        contextKey: `project:${REPO_ID}`,
        runtimeRevision: "rev-1",
        activeLeaseCount: 2,
        upstreamCount: 1,
      },
      {
        context: { kind: "project", projectId: REPO_ID },
        projectRoot: "/repo",
        contextKey: `project:${REPO_ID}`,
        runtimeRevision: "rev-2",
        activeLeaseCount: 1,
        upstreamCount: 1,
      },
    ]);
  });

  it("coalesces concurrent builds for the same generation", async () => {
    let finishBuild: (() => void) | undefined;
    const buildGate = new Promise<void>((resolve) => {
      finishBuild = resolve;
    });
    const build = vi.fn(async (snapshot: ResolvedGatewaySnapshot) => {
      await buildGate;
      return gateway(snapshot.runtimeRevision);
    });
    const pool = new InMemoryScopedGatewayPool(build);
    const snapshot = {
      kind: "project",
      projectId: REPO_ID,
      projectRoot: "/repo",
      contextKey: `project:${REPO_ID}`,
      runtimeRevision: "rev-1",
    } as const;

    const first = pool.acquire(snapshot);
    const second = pool.acquire({ ...snapshot });

    expect(build).toHaveBeenCalledOnce();
    finishBuild?.();
    const [one, two] = await Promise.all([first, second]);
    expect(one.gateway).toBe(two.gateway);
  });

  it("closes every revision of a context on shutdown", async () => {
    const pool = new InMemoryScopedGatewayPool(async (snapshot) =>
      gateway(snapshot.runtimeRevision),
    );
    const context = {
      kind: "project",
      projectId: REPO_ID,
      projectRoot: "/repo",
      contextKey: `project:${REPO_ID}`,
    } as const;
    const oldGeneration = await pool.acquire({ ...context, runtimeRevision: "rev-1" });
    const newGeneration = await pool.acquire({ ...context, runtimeRevision: "rev-2" });

    await pool.shutdown();

    expect(oldGeneration.gateway.close).toHaveBeenCalledOnce();
    expect(newGeneration.gateway.close).toHaveBeenCalledOnce();
    expect(pool.stats().generations).toEqual([]);
    await expect(pool.acquire({ ...context, runtimeRevision: "rev-3" })).rejects.toThrow(
      "gateway pool is shutting down",
    );
  });

  it("shares a gateway for one scope and closes it after the last lease", async () => {
    const built: GatewayHandle[] = [];
    const pool = new InMemoryScopedGatewayPool(async (scope) => {
      const next = gateway(scope.kind === "global" ? "global" : scope.projectRoot);
      built.push(next);
      return next;
    });

    const one = await pool.acquire({ kind: "project", projectRoot: "/repo" });
    const two = await pool.acquire({ kind: "project", projectRoot: "/repo" });

    expect(built).toHaveLength(1);
    expect(one.gateway).toBe(two.gateway);
    expect(pool.stats()).toMatchObject({ activeGatewayCount: 1, activeProjectGatewayCount: 1 });

    await one.release();
    expect(one.gateway.close).not.toHaveBeenCalled();
    await two.release();
    expect(one.gateway.close).toHaveBeenCalledOnce();
    expect(pool.stats().activeGatewayCount).toBe(0);
  });

  it("isolates user and different project scopes", async () => {
    const pool = new InMemoryScopedGatewayPool(async (scope) =>
      gateway(scope.kind === "global" ? "global" : scope.projectRoot),
    );

    const user = await pool.acquire({ kind: "user" });
    const a = await pool.acquire({ kind: "project", projectRoot: "/a" });
    const b = await pool.acquire({ kind: "project", projectRoot: "/b" });

    expect(new Set([user.gateway, a.gateway, b.gateway]).size).toBe(3);
    expect(pool.stats()).toMatchObject({
      activeGatewayCount: 3,
      activeUserGatewayCount: 1,
      activeProjectGatewayCount: 2,
    });

    await pool.shutdown();
    expect(user.gateway.close).toHaveBeenCalledOnce();
    expect(a.gateway.close).toHaveBeenCalledOnce();
    expect(b.gateway.close).toHaveBeenCalledOnce();
  });

  it("fans gateway list changes out only to leases in that scope", async () => {
    const gateways: GatewayHandle[] = [];
    const pool = new InMemoryScopedGatewayPool(async (scope) => {
      const next = gateway(scope.kind === "global" ? "global" : scope.projectRoot);
      gateways.push(next);
      return next;
    });
    const one = await pool.acquire({ kind: "project", projectRoot: "/repo" });
    const two = await pool.acquire({ kind: "project", projectRoot: "/repo" });
    const other = await pool.acquire({ kind: "user" });
    const firstListener = vi.fn(async () => {});
    const secondListener = vi.fn(async () => {});
    const otherListener = vi.fn(async () => {});
    one.subscribeListChanged(firstListener);
    two.subscribeListChanged(secondListener);
    other.subscribeListChanged(otherListener);

    const notifier = vi.mocked(gateways[0].setListChangedNotifier).mock.calls[0][0];
    await notifier?.();

    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
    expect(otherListener).not.toHaveBeenCalled();
  });
});
