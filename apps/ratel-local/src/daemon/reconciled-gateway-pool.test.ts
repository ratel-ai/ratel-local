import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContextSnapshotResolver,
  GatewayHandle,
  ProjectAdmissionLock,
  ProjectId,
  ProjectRegistry,
  ResolvedContextSnapshot,
  RuntimeRevision,
} from "@ratel-ai/ratel-local-core";
import {
  createContextSnapshotResolver,
  createProjectRegistry,
  InvalidContextSnapshotError,
} from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { ReconciledGatewayPool } from "./reconciled-gateway-pool.js";
import { InMemoryScopedGatewayPool } from "./scoped-gateway-pool.js";

const projectId = "prj_reconciled" as ProjectId;

function gateway(revision: string): GatewayHandle {
  return {
    catalog: { revision } as never,
    skillCatalog: {} as never,
    upstreamServers: [],
    close: vi.fn(async () => {}),
    runAuthFlow: vi.fn(async () => []),
    setListChangedNotifier: vi.fn(),
  };
}

function snapshot(revision: string): ResolvedContextSnapshot {
  return {
    context: { kind: "project", projectId },
    projectRoot: "/repo",
    documents: [],
    runtimeRevision: revision as RuntimeRevision,
    mcpEntries: [],
    skills: {
      effectiveSkills: [],
      registrations: [],
      diagnostics: [],
      fingerprint: revision,
      watchInputs: [],
    },
    diagnostics: [],
    watchInputs: [],
  };
}

describe("ReconciledGatewayPool", () => {
  it("registers connector roots and keys generations by project id and runtime revision", async () => {
    let current = snapshot("rev-1");
    const registry = {
      registerRoot: vi.fn(async () => ({
        id: projectId,
        canonicalRoot: "/repo",
        displayName: "repo",
        lastSeenAt: "2026-07-15T00:00:00.000Z",
      })),
    } as unknown as ProjectRegistry;
    const resolver = {
      resolve: vi.fn(async () => current),
    } satisfies ContextSnapshotResolver;
    const generations = new InMemoryScopedGatewayPool(async (generation) =>
      gateway(generation.runtimeRevision),
    );
    const onRevision = vi.fn();
    const admissionLock: ProjectAdmissionLock = { run: vi.fn((operation) => operation()) };
    const pool = new ReconciledGatewayPool({
      generations,
      registry,
      resolver,
      onRevision,
      admissionLock,
      watch: false,
    });

    const oldLease = await pool.acquire({ kind: "project", projectRoot: "/repo-alias" });
    current = snapshot("rev-2");
    const newLease = await pool.acquire({ kind: "project", projectRoot: "/repo-alias" });

    expect(registry.registerRoot).toHaveBeenCalledWith("/repo-alias");
    expect(admissionLock.run).toHaveBeenCalledTimes(2);
    expect(resolver.resolve).toHaveBeenCalledWith({ kind: "project", projectId });
    expect(oldLease.contextKey).toBe(`project:${projectId}`);
    expect(oldLease.runtimeRevision).toBe("rev-1");
    expect(newLease.runtimeRevision).toBe("rev-2");
    expect(oldLease.gateway).not.toBe(newLease.gateway);
    expect(onRevision).toHaveBeenLastCalledWith({ kind: "project", projectId }, "rev-2");

    await oldLease.release();
    await newLease.release();
    await pool.shutdown();
  });

  it("reconciles global state on every acquire", async () => {
    const global = {
      ...snapshot("global-rev"),
      context: { kind: "global" as const },
      projectRoot: undefined,
    };
    const resolver = { resolve: vi.fn(async () => global) } satisfies ContextSnapshotResolver;
    const generations = new InMemoryScopedGatewayPool(async (generation) =>
      gateway(generation.runtimeRevision),
    );
    const pool = new ReconciledGatewayPool({
      generations,
      registry: {} as ProjectRegistry,
      resolver,
      watch: false,
    });

    const first = await pool.acquire({ kind: "user" });
    const second = await pool.acquire({ kind: "user" });
    await pool.reconcileContext({ kind: "global" });

    expect(resolver.resolve).toHaveBeenCalledTimes(3);
    expect(first.context).toEqual({ kind: "global" });
    expect(first.gateway).toBe(second.gateway);
    await first.release();
    await second.release();
  });

  it("detects atomic config replacement and keeps the last valid generation on invalid input", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-reconciled-watch-"));
    const homeDir = join(root, "home");
    const projectRoot = join(root, "project");
    const configDir = join(projectRoot, ".ratel");
    const configPath = join(configDir, "config.json");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { first: { type: "stdio", command: "first" } } }),
    );
    const registry = createProjectRegistry({ homeDir });
    await registry.registerRoot(projectRoot);
    const resolver = createContextSnapshotResolver({ homeDir, projectRegistry: registry });
    const built: GatewayHandle[] = [];
    const generations = new InMemoryScopedGatewayPool(async (generation) => {
      const builtGateway = gateway(generation.runtimeRevision);
      built.push(builtGateway);
      return builtGateway;
    });
    const revisions: string[] = [];
    const invalid: Error[] = [];
    const pool = new ReconciledGatewayPool({
      generations,
      registry,
      resolver,
      debounceMs: 20,
      onRevision: (_context, revision) => revisions.push(revision),
      onInvalidSnapshot: (_context, error) => invalid.push(error),
    });

    try {
      const oldLease = await pool.acquire({ kind: "project", projectRoot });
      const replacement = `${configPath}.replacement`;
      await writeFile(
        replacement,
        JSON.stringify({ mcpServers: { second: { type: "stdio", command: "second" } } }),
      );
      await rename(replacement, configPath);
      await waitFor(() => revisions.some((revision) => revision !== oldLease.runtimeRevision));

      const newLease = await pool.acquire({ kind: "project", projectRoot });
      expect(newLease.runtimeRevision).not.toBe(oldLease.runtimeRevision);
      expect(oldLease.gateway).not.toBe(newLease.gateway);
      expect(oldLease.gateway.close).not.toHaveBeenCalled();

      await writeFile(configPath, "{invalid json");
      await waitFor(() => invalid.length > 0);
      expect(invalid[0]).toBeInstanceOf(InvalidContextSnapshotError);
      await expect(pool.acquire({ kind: "project", projectRoot })).rejects.toBeInstanceOf(
        InvalidContextSnapshotError,
      );
      expect(oldLease.gateway.close).not.toHaveBeenCalled();

      await oldLease.release();
      await newLease.release();
      expect(built).toHaveLength(2);
    } finally {
      await pool.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for watcher reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
