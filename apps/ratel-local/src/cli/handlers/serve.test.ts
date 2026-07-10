import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import { resolveAutoConfig, runServe } from "./serve.js";

const HOME = "/home/u";

function serveArgs(input: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    group: "serve",
    configPaths: [],
    rest: [],
    extras: [],
    flags: { telemetry: "off" },
    ...input,
  };
}

class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: Transport["onmessage"];

  async start() {}
  async send() {}
  async close() {
    this.onclose?.();
  }
}

describe("resolveAutoConfig", () => {
  it("loads only the user config when no project root is discoverable", () => {
    const resolved = resolveAutoConfig(serveArgs({ flags: { "auto-config": true } }), {
      env: { homeDir: HOME },
      processEnv: {},
      cwd: "/nowhere",
      existsSync: () => false,
    });

    expect(resolved).toEqual({
      configPaths: ["/home/u/.ratel/config.json"],
    });
  });

  it("uses --project-root before environment or cwd discovery", () => {
    const resolved = resolveAutoConfig(
      serveArgs({ flags: { "auto-config": true, "project-root": "/explicit" } }),
      {
        env: { homeDir: HOME },
        processEnv: { RATEL_PROJECT_ROOT: "/env", CLAUDE_PROJECT_DIR: "/claude" },
        cwd: "/repo/sub",
        existsSync: () => true,
      },
    );

    expect(resolved.projectRoot).toBe("/explicit");
    expect(resolved.projectRootSource).toBe("flag");
    expect(resolved.configPaths).toEqual([
      "/home/u/.ratel/config.json",
      "/explicit/.ratel/config.json",
      "/explicit/.ratel/config.local.json",
    ]);
  });

  it("uses RATEL_PROJECT_ROOT before CLAUDE_PROJECT_DIR", () => {
    const resolved = resolveAutoConfig(serveArgs({ flags: { "auto-config": true } }), {
      env: { homeDir: HOME },
      processEnv: { RATEL_PROJECT_ROOT: "/env", CLAUDE_PROJECT_DIR: "/claude" },
      cwd: "/repo/sub",
      existsSync: () => true,
    });

    expect(resolved.projectRoot).toBe("/env");
    expect(resolved.projectRootSource).toBe("RATEL_PROJECT_ROOT");
  });

  it("uses CLAUDE_PROJECT_DIR when no Ratel-specific project root is set", () => {
    const resolved = resolveAutoConfig(serveArgs({ flags: { "auto-config": true } }), {
      env: { homeDir: HOME },
      processEnv: { CLAUDE_PROJECT_DIR: "/claude" },
      cwd: "/repo/sub",
      existsSync: () => true,
    });

    expect(resolved.projectRoot).toBe("/claude");
    expect(resolved.projectRootSource).toBe("CLAUDE_PROJECT_DIR");
  });

  it("falls back to cwd project-root discovery", () => {
    const resolved = resolveAutoConfig(serveArgs({ flags: { "auto-config": true } }), {
      env: { homeDir: HOME },
      processEnv: {},
      cwd: "/repo/sub",
      existsSync: (path) => path === "/repo/pnpm-workspace.yaml",
    });

    expect(resolved.projectRoot).toBe("/repo");
    expect(resolved.projectRootSource).toBe("cwd");
    expect(resolved.configPaths).toEqual([
      "/home/u/.ratel/config.json",
      "/repo/.ratel/config.json",
      "/repo/.ratel/config.local.json",
    ]);
  });
});

describe("runServe auto-config", () => {
  it("starts with an empty catalog when no config files exist", async () => {
    const readPaths: string[] = [];
    const result = await runServe(
      serveArgs({ flags: { "auto-config": true, telemetry: "off" } }),
      {
        env: { homeDir: HOME },
        processEnv: {},
        cwd: "/nowhere",
        existsSync: () => false,
        serverTransport: new FakeTransport(),
        readConfig: async (path) => {
          readPaths.push(path);
          return { mcpServers: {} };
        },
      },
      () => {},
    );

    expect(readPaths).toEqual(["/home/u/.ratel/config.json"]);
    await result.shutdown();
  });

  it("rejects mixing --auto-config with explicit config paths", async () => {
    await expect(
      runServe(
        serveArgs({
          configPaths: ["manual.json"],
          flags: { "auto-config": true, telemetry: "off" },
        }),
        { serverTransport: new FakeTransport() },
        () => {},
      ),
    ).rejects.toThrow(/--auto-config cannot be combined/);
  });

  it("keeps explicit --config mode unchanged", async () => {
    const readPaths: string[] = [];
    const result = await runServe(
      serveArgs({ configPaths: ["manual.json"], flags: { telemetry: "off" } }),
      {
        serverTransport: new FakeTransport(),
        readConfig: async (path) => {
          readPaths.push(path);
          return { mcpServers: {} };
        },
      },
      () => {},
    );

    expect(readPaths).toEqual(["manual.json"]);
    await result.shutdown();
  });
});
