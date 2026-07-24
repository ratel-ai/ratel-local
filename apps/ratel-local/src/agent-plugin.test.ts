import { describe, expect, it } from "vitest";
import {
  type AgentPluginCommandResult,
  type AgentPluginCommandRunner,
  installRatelAgentPlugin,
  ratelMarketplaceRefForVersion,
} from "./agent-plugin.js";

const SUCCESS: AgentPluginCommandResult = { exitCode: 0, stdout: "ok", stderr: "" };

describe("ratelMarketplaceRefForVersion", () => {
  it("pins prerelease packages to their immutable release tag", () => {
    expect(ratelMarketplaceRefForVersion("0.6.0-rc.0")).toBe("v0.6.0-rc.0");
    expect(ratelMarketplaceRefForVersion("1.0.0-beta.2")).toBe("v1.0.0-beta.2");
  });

  it("keeps stable and unknown package versions on the default marketplace branch", () => {
    expect(ratelMarketplaceRefForVersion("0.6.0")).toBeUndefined();
    expect(ratelMarketplaceRefForVersion("dev")).toBeUndefined();
    expect(ratelMarketplaceRefForVersion()).toBeUndefined();
  });
});

describe("installRatelAgentPlugin", () => {
  it("installs a stable Codex plugin directly when the Ratel marketplace is available", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return SUCCESS;
    };

    const result = await installRatelAgentPlugin("codex", runner, {
      packageVersion: "0.6.0",
    });

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

  it("pins a fresh Claude Code RC installation to the matching release tag", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return SUCCESS;
    };

    const result = await installRatelAgentPlugin("claude-code", runner, {
      packageVersion: "0.6.0-rc.0",
    });

    expect(result).toEqual({
      installed: true,
      message: "Ratel Local plugin installed for Claude Code from v0.6.0-rc.0.",
    });
    expect(commands).toEqual([
      {
        command: "git",
        args: [
          "ls-remote",
          "--exit-code",
          "https://github.com/ratel-ai/ratel-local.git",
          "refs/tags/v0.6.0-rc.0",
        ],
      },
      {
        command: "claude",
        args: ["plugin", "marketplace", "add", "ratel-ai/ratel-local@v0.6.0-rc.0"],
      },
      {
        command: "claude",
        args: ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
      },
    ]);
  });

  it("retargets an existing Codex marketplace to the RC tag before reinstalling", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return SUCCESS;
    };

    const result = await installRatelAgentPlugin("codex", runner, {
      packageVersion: "0.6.0-rc.0",
      reconcileMarketplace: true,
    });

    expect(result.installed).toBe(true);
    expect(commands).toEqual([
      {
        command: "git",
        args: [
          "ls-remote",
          "--exit-code",
          "https://github.com/ratel-ai/ratel-local.git",
          "refs/tags/v0.6.0-rc.0",
        ],
      },
      {
        command: "codex",
        args: ["plugin", "marketplace", "remove", "ratel"],
      },
      {
        command: "codex",
        args: [
          "plugin",
          "marketplace",
          "add",
          "ratel-ai/ratel-local",
          "--ref",
          "v0.6.0-rc.0",
          "--json",
        ],
      },
      {
        command: "codex",
        args: ["plugin", "add", "ratel-local@ratel", "--json"],
      },
    ]);
  });

  it("switches a conflicting Claude Code stable marketplace to the RC tag", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const results: AgentPluginCommandResult[] = [
      SUCCESS,
      {
        exitCode: 1,
        stdout: "",
        stderr: "Marketplace ratel already exists from a different source",
      },
      SUCCESS,
      SUCCESS,
      SUCCESS,
    ];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return results.shift() as AgentPluginCommandResult;
    };

    const result = await installRatelAgentPlugin("claude-code", runner, {
      packageVersion: "0.6.0-rc.0",
    });

    expect(result.installed).toBe(true);
    expect(commands.map(({ args }) => args)).toEqual([
      [
        "ls-remote",
        "--exit-code",
        "https://github.com/ratel-ai/ratel-local.git",
        "refs/tags/v0.6.0-rc.0",
      ],
      ["plugin", "marketplace", "add", "ratel-ai/ratel-local@v0.6.0-rc.0"],
      ["plugin", "marketplace", "remove", "ratel"],
      ["plugin", "marketplace", "add", "ratel-ai/ratel-local@v0.6.0-rc.0"],
      ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
    ]);
  });

  it("leaves an existing plugin untouched when the RC tag cannot be resolved", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return { exitCode: 2, stdout: "", stderr: "remote ref not found" };
    };

    const result = await installRatelAgentPlugin("codex", runner, {
      packageVersion: "0.6.0-rc.0",
      reconcileMarketplace: true,
    });

    expect(result).toEqual({
      installed: false,
      pluginAvailable: true,
      message:
        "Could not verify Ratel marketplace ref v0.6.0-rc.0: remote ref not found. Existing plugin installation was left unchanged.",
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toBe("git");
  });

  it("restores the stable Claude Code plugin when an RC reinstall fails", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const results: AgentPluginCommandResult[] = [
      SUCCESS,
      SUCCESS,
      SUCCESS,
      { exitCode: 1, stdout: "", stderr: "RC plugin cache failed" },
      SUCCESS,
      SUCCESS,
      SUCCESS,
    ];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return results.shift() as AgentPluginCommandResult;
    };

    const result = await installRatelAgentPlugin("claude-code", runner, {
      packageVersion: "0.6.0-rc.0",
      reconcileMarketplace: true,
    });

    expect(result).toEqual({
      installed: false,
      pluginAvailable: true,
      message:
        "claude plugin installation failed: RC plugin cache failed Restored the stable Ratel Local plugin for Claude Code; the requested release-candidate channel is not active.",
    });
    expect(commands.map(({ args }) => args)).toEqual([
      [
        "ls-remote",
        "--exit-code",
        "https://github.com/ratel-ai/ratel-local.git",
        "refs/tags/v0.6.0-rc.0",
      ],
      ["plugin", "marketplace", "remove", "ratel"],
      ["plugin", "marketplace", "add", "ratel-ai/ratel-local@v0.6.0-rc.0"],
      ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
      ["plugin", "marketplace", "remove", "ratel"],
      ["plugin", "marketplace", "add", "ratel-ai/ratel-local"],
      ["plugin", "install", "ratel-local@ratel", "--scope", "user"],
    ]);
  });

  it("reports an unavailable plugin when stable reconciliation fails after removal", async () => {
    const results: AgentPluginCommandResult[] = [
      SUCCESS,
      SUCCESS,
      { exitCode: 1, stdout: "", stderr: "stable plugin install failed" },
    ];
    const runner: AgentPluginCommandRunner = async () =>
      results.shift() as AgentPluginCommandResult;

    const result = await installRatelAgentPlugin("codex", runner, {
      packageVersion: "0.6.0",
      reconcileMarketplace: true,
    });

    expect(result).toEqual({
      installed: false,
      pluginAvailable: false,
      message: "codex plugin installation failed: stable plugin install failed",
    });
  });

  it("adds the marketplace and retries when direct stable installation fails", async () => {
    const commands: Array<{ command: string; args: string[] }> = [];
    const results: AgentPluginCommandResult[] = [
      { exitCode: 1, stdout: "", stderr: "marketplace not found" },
      SUCCESS,
      SUCCESS,
    ];
    const runner: AgentPluginCommandRunner = async (command, args) => {
      commands.push({ command, args: [...args] });
      return results.shift() as AgentPluginCommandResult;
    };

    const result = await installRatelAgentPlugin("claude-code", runner, {
      packageVersion: "0.6.0",
    });

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

    const result = await installRatelAgentPlugin("codex", runner, {
      packageVersion: "0.6.0",
    });

    expect(result).toEqual({
      installed: false,
      message: "codex plugin installation failed: command not found: codex",
    });
  });
});
