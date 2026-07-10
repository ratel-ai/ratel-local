import type { GatewayHandle } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryScopedGatewayPool } from "./scoped-gateway-pool.js";

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
  it("shares a gateway for one scope and closes it after the last lease", async () => {
    const built: GatewayHandle[] = [];
    const pool = new InMemoryScopedGatewayPool(async (scope) => {
      const next = gateway(scope.kind === "user" ? "user" : scope.projectRoot);
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
      gateway(scope.kind === "user" ? "user" : scope.projectRoot),
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
      const next = gateway(scope.kind === "user" ? "user" : scope.projectRoot);
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
