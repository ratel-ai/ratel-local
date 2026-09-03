import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
import { createProjectRegistry } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { CLOUD_CATALOG_FEATURE_ENV } from "../../feature-flags.js";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import { runDaemon } from "./daemon.js";
import { createTestPreparedChanges } from "./test-prepared-changes.js";
import type { HandlerCtx } from "./types.js";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, content: string) {
    this.files.set(path, content);
  }
  async writeAtomic(path: string, content: string) {
    this.files.set(path, content);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdirp() {}
  async exists(path: string) {
    return this.files.has(path);
  }
  async list() {
    return [];
  }
}

function makeCtx(fs: MemFs, env: HierarchyEnv): HandlerCtx {
  return {
    argv: { group: "daemon", configPaths: [], rest: [], extras: [], flags: {} } as ParsedArgs,
    env,
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The same 5s /healthz poll `waitForDaemon` runs after launchd/systemd starts the daemon. */
async function pollHealthz(port: number, timeoutMs: number): Promise<number | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return Date.now() - started;
    } catch {
      // daemon not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

describe("daemon startup budget", () => {
  it("serves /healthz within the restart budget while Cloud hangs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-startup-repro-"));
    const projectA = join(homeDir, "project-a");
    const projectB = join(homeDir, "project-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    const registry = createProjectRegistry({ homeDir });
    await registry.registerRoot(projectA);
    await registry.registerRoot(projectB);

    const callsAt: number[] = [];
    const started = Date.now();
    // Cloud accepts the connection and never answers: only the loader's own
    // AbortSignal.timeout(10s) ends the request.
    const catalogFetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          callsAt.push(Date.now() - started);
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "TimeoutError")),
          );
        }),
    );

    const port = await freePort();
    const fs = new MemFs();
    const ctx = makeCtx(fs, { homeDir, projectRoot: projectA });
    const booting = runDaemon(
      {
        group: "daemon",
        configPaths: [],
        rest: [],
        extras: [],
        flags: { open: false, telemetry: "off", port: String(port) },
      } as ParsedArgs,
      ctx,
      { processEnv: { [CLOUD_CATALOG_FEATURE_ENV]: "1", RATEL_API_KEY: "rtl_repro" } },
      () => {},
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudCatalogFetch: catalogFetch as unknown as typeof fetch,
        cloudTraceSettingsStore: { load: async () => undefined, save: async () => {} },
        preparedChanges: createTestPreparedChanges(fs),
      },
    );

    const healthyWithin5s = await pollHealthz(port, 5_000);
    const result = await booting;
    const bootMs = Date.now() - started;
    try {
      expect(healthyWithin5s).toBeDefined();
      // The migration resolves the global context plus every registered project;
      // one catalog pull each would overrun the budget on its own.
      expect(catalogFetch).not.toHaveBeenCalled();
      expect(bootMs).toBeLessThan(5_000);
      expect(callsAt).toEqual([]);
    } finally {
      await result.shutdown?.();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 90_000);
});
