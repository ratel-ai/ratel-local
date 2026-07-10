import type { BackupFs, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { resolveSetupServiceExecutable, runSetup } from "./setup.js";
import type { HandlerCtx } from "./types.js";

class MemFs implements BackupFs, JsonFs {
  async read() {
    return null;
  }
  async write() {}
  async writeAtomic() {}
  async remove() {}
  async mkdirp() {}
  async exists() {
    return false;
  }
  async list() {
    return [];
  }
}

function setupCtx(overrides: Partial<HandlerCtx> = {}): HandlerCtx {
  return {
    argv: {
      group: "setup",
      configPaths: [],
      rest: [],
      extras: [],
      flags: {},
    },
    env: { homeDir: "/home/u", projectRoot: "/repo" },
    fs: new MemFs(),
    log: () => {},
    prompts: silentPromptAdapter(),
    ...overrides,
  };
}

describe("runSetup", () => {
  it("persists a stable node+npx package runner instead of the npx cache script", () => {
    expect(
      resolveSetupServiceExecutable({
        expectedVersion: "0.5.0-rc.0",
        env: { PATH: "/opt/node/bin" },
        execPath: "/opt/node/bin/node",
        argv1: "/home/u/.npm/_npx/cache/node_modules/@ratel-ai/ratel-local/dist/bin.js",
        isExecutable: (path) => path === "/opt/node/bin/npx",
      }),
    ).toEqual({
      executablePath: "/opt/node/bin/node",
      executableArgs: ["/opt/node/bin/npx", "-y", "@ratel-ai/ratel-local@0.5.0-rc.0"],
    });
  });

  it("is idempotent when the daemon is already running", async () => {
    const notes: string[] = [];
    const install = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const ctx = setupCtx({
      prompts: { ...silentPromptAdapter(), note: (message) => notes.push(message) },
    });

    const result = await runSetup(ctx, {
      inspect: async () => ({ state: "running", port: 5731 }),
      install,
      start,
    });

    expect(result).toEqual({ state: "running", port: 5731, changed: false });
    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(notes.join("\n")).toContain("already running");
  });

  it("starts an installed daemon after confirmation", async () => {
    const start = vi.fn(async () => {});
    let inspection = 0;

    const result = await runSetup(setupCtx(), {
      inspect: async () => {
        inspection++;
        return inspection === 1
          ? { state: "stopped", port: 5731 }
          : { state: "running", port: 5731 };
      },
      install: vi.fn(async () => {}),
      start,
    });

    expect(start).toHaveBeenCalledOnce();
    expect(result).toEqual({ state: "running", port: 5731, changed: true });
  });

  it("installs a missing daemon service after confirmation", async () => {
    const install = vi.fn(async () => {});
    let inspection = 0;

    const result = await runSetup(setupCtx(), {
      inspect: async () => {
        inspection++;
        return inspection === 1
          ? { state: "not-installed", port: 7331 }
          : { state: "running", port: 7331 };
      },
      install,
      start: vi.fn(async () => {}),
    });

    expect(install).toHaveBeenCalledOnce();
    expect(result).toEqual({ state: "running", port: 7331, changed: true });
  });

  it("performs no lifecycle mutation when setup is declined", async () => {
    const install = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const ctx = setupCtx({
      prompts: { ...silentPromptAdapter(), confirm: async () => false },
    });

    const result = await runSetup(ctx, {
      inspect: async () => ({ state: "not-installed", port: 5731 }),
      install,
      start,
    });

    expect(result).toEqual({ state: "not-installed", port: 5731, changed: false });
    expect(install).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("skips confirmation in --yes mode", async () => {
    const confirm = vi.fn(async () => false);
    const install = vi.fn(async () => {});
    let inspection = 0;
    const ctx = setupCtx({
      prompts: { ...silentPromptAdapter(), confirm },
    });

    await runSetup(ctx, {
      yes: true,
      inspect: async () => {
        inspection++;
        return inspection === 1
          ? { state: "not-installed", port: 5731 }
          : { state: "running", port: 5731 };
      },
      install,
      start: vi.fn(async () => {}),
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledOnce();
  });

  it("does not apply the first-install port override to an existing service", async () => {
    const ctx = setupCtx({
      argv: {
        group: "setup",
        configPaths: [],
        rest: [],
        extras: [],
        flags: { port: "7331" },
      },
    });
    const inspectedPorts: unknown[] = [];
    let inspection = 0;

    await runSetup(ctx, {
      inspect: async (parsed) => {
        inspectedPorts.push(parsed.flags.port);
        inspection++;
        return inspection === 1
          ? { state: "stopped", port: 5731 }
          : { state: "running", port: 5731 };
      },
      install: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
    });

    expect(inspectedPorts).toEqual([undefined, undefined]);
  });

  it("replaces a daemon service running an incompatible package version", async () => {
    const upgrade = vi.fn(async () => {});
    let inspection = 0;
    const ctx = setupCtx({
      argv: {
        group: "setup",
        configPaths: [],
        rest: [],
        extras: [],
        flags: { port: "8444" },
      },
    });

    const result = await runSetup(ctx, {
      expectedVersion: "0.5.0-rc.0",
      inspect: async () => {
        inspection++;
        return inspection === 1
          ? { state: "running", port: 7331, version: "0.4.0" }
          : { state: "running", port: 7331, version: "0.5.0-rc.0" };
      },
      install: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      upgrade,
    });

    expect(upgrade).toHaveBeenCalledWith(7331);
    expect(result).toEqual({
      state: "running",
      port: 7331,
      version: "0.5.0-rc.0",
      changed: true,
    });
  });
});
