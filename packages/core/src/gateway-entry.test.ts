import { describe, expect, it } from "vitest";
import { isRatelGatewayEntry, makeRatelGatewayEntry } from "./gateway-entry.js";
import type { ServerEntry } from "./lib/index.js";

describe("Ratel gateway entries", () => {
  it("builds a connector entry with host and user-link metadata", () => {
    const gateway = makeRatelGatewayEntry({
      bin: { command: "ratel-local", args: [], source: "path" },
      agentHost: "claude-code",
      linkScope: "user",
    });

    expect(gateway).toEqual({
      name: "ratel-local",
      entry: {
        type: "stdio",
        command: "ratel-local",
        args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
      },
    });
  });

  it("pins project connectors to the project root", () => {
    const gateway = makeRatelGatewayEntry({
      bin: { command: "node", args: ["/repo/dist/bin.js"], source: "workspace" },
      agentHost: "codex",
      linkScope: "project",
      projectRoot: "/workspace/project-a",
    });

    expect(gateway.entry.args).toEqual([
      "/repo/dist/bin.js",
      "connect",
      "--agent-host",
      "codex",
      "--link-scope",
      "project",
      "--project-root",
      "/workspace/project-a",
    ]);
  });

  it("recognizes connector and legacy serve entries only when command and args match Ratel", () => {
    const connector: ServerEntry = {
      type: "stdio",
      command: "/usr/local/bin/ratel-local",
      args: ["connect", "--agent-host", "codex", "--link-scope", "user"],
    };
    const legacy: ServerEntry = {
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", "/home/u/.ratel/config.json"],
    };

    expect(isRatelGatewayEntry("ratel-local", connector)).toBe(true);
    expect(isRatelGatewayEntry("ratel-mcp", legacy)).toBe(true);
    expect(
      isRatelGatewayEntry("ratel", { type: "stdio", command: "unrelated", args: ["serve"] }),
    ).toBe(false);
    expect(
      isRatelGatewayEntry("ratel", {
        type: "stdio",
        command: "ratel-local",
        args: ["something-else"],
      }),
    ).toBe(false);
    expect(isRatelGatewayEntry("ratel", { type: "stdio", command: "ratel-local" })).toBe(false);
    expect(isRatelGatewayEntry("filesystem", connector)).toBe(false);
  });

  it("verifies the Ratel package when the gateway is launched through npx", () => {
    expect(
      isRatelGatewayEntry("ratel-local", {
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          "@ratel-ai/ratel-local@0.5.0",
          "connect",
          "--agent-host",
          "claude-code",
          "--link-scope",
          "user",
        ],
      }),
    ).toBe(true);
    expect(
      isRatelGatewayEntry("ratel-local", {
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          "unrelated-package",
          "connect",
          "--agent-host",
          "claude-code",
          "--link-scope",
          "user",
        ],
      }),
    ).toBe(false);
  });

  it("recognizes the packaged executable path used by local builds", () => {
    expect(
      isRatelGatewayEntry("ratel-local", {
        type: "stdio",
        command: "/workspace/apps/ratel-local/dist/bin.js",
        args: ["connect", "--agent-host", "codex", "--link-scope", "user"],
      }),
    ).toBe(true);
  });

  it("rejects unrelated node scripts and connector scope/root mismatches", () => {
    expect(
      isRatelGatewayEntry("ratel", {
        type: "stdio",
        command: "node",
        args: [
          "/workspace/unrelated/dist/bin.js",
          "connect",
          "--agent-host",
          "codex",
          "--link-scope",
          "user",
        ],
      }),
    ).toBe(false);
    expect(
      isRatelGatewayEntry("ratel-local", {
        type: "stdio",
        command: "ratel-local",
        args: ["connect", "--agent-host", "codex", "--link-scope", "project"],
      }),
    ).toBe(false);
    expect(
      isRatelGatewayEntry("ratel-local", {
        type: "stdio",
        command: "ratel-local",
        args: [
          "connect",
          "--agent-host",
          "codex",
          "--link-scope",
          "user",
          "--project-root",
          "/repo",
        ],
      }),
    ).toBe(false);
  });
});
