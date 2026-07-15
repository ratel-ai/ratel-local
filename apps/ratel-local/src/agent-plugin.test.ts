import { describe, expect, it } from "vitest";
import { type AgentPluginCommandRunner, installRatelAgentPlugin } from "./agent-plugin.js";

describe("installRatelAgentPlugin", () => {
  it("installs the Codex plugin directly when the Ratel marketplace is already available", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return { exitCode: 0, stdout: '{"installed":true}', stderr: "" };
    };

    const result = await installRatelAgentPlugin("codex", runner);

    expect(result).toEqual({
      installed: true,
      message: "Ratel Local plugin installed for Codex.",
    });
    expect(commands).toEqual([
      {
        command: "codex",
        args: ["plugin", "add", "ratel-local@ratel", "--json"],
      },
    ]);
  });

  it("adds the marketplace and retries when direct Claude Code installation fails", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const results = [
      { exitCode: 1, stdout: "", stderr: "marketplace not found" },
      { exitCode: 0, stdout: "marketplace added", stderr: "" },
      { exitCode: 0, stdout: "plugin installed", stderr: "" },
    ];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return results.shift() as (typeof results)[number];
    };

    const result = await installRatelAgentPlugin("claude-code", runner);

    expect(result.installed).toBe(true);
    expect(commands).toEqual([
      {
        command: "claude",
        args: ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
      },
      {
        command: "claude",
        args: ["plugin", "marketplace", "add", "ratel-ai/ratel-local"],
      },
      {
        command: "claude",
        args: ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
      },
    ]);
  });

  it("returns the installation error so callers can explain an MCP fallback", async () => {
    const runner: AgentPluginCommandRunner = async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "command not found: codex",
    });

    const result = await installRatelAgentPlugin("codex", runner);

    expect(result).toEqual({
      installed: false,
      message: "codex plugin installation failed: command not found: codex",
    });
  });
});
