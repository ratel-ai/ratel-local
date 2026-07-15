import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackupFs,
  createMutationEngine,
  executePlan,
  type JsonFs,
  nodeFs,
  type ResolvedBin,
} from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import { type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runLink } from "./link.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const BIN: ResolvedBin = { command: "ratel-local", args: [], source: "path" };

const HOME_CLAUDE = "/home/u/.claude.json";
const CLAUDE_SETTINGS = "/home/u/.claude/settings.json";
const HOME_CODEX = "/home/u/.codex/config.toml";
const PROJECT_MCP = "/r/.mcp.json";
const RATEL_USER = "/home/u/.ratel/config.json";
const RATEL_PROJECT = "/r/.ratel/config.json";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? (this.files.get(p) as string) : null;
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async writeAtomic(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p);
  }
  async list(p: string) {
    const prefix = p.endsWith("/") ? p : `${p}/`;
    const names = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        names.add(slash >= 0 ? rest.slice(0, slash) : rest);
      }
    }
    return Array.from(names);
  }
}

function ctxOf(
  fs: MemFs,
  prompts: PromptAdapter = silentPromptAdapter(),
  withProjectRoot = true,
): { ctx: HandlerCtx; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    ctx: {
      argv: { group: "link", configPaths: [], rest: [], extras: [], flags: {} },
      env: { homeDir: HOME, projectRoot: withProjectRoot ? ROOT : undefined },
      fs,
      log: (m) => logs.push(m),
      planExecutor: executePlan,
      prompts,
      installAgentPlugin: async () => ({
        installed: false,
        message: "test plugin installation failed",
      }),
    },
  };
}

function autoConfirm(): PromptAdapter {
  return {
    ...silentPromptAdapter(),
    async confirm() {
      return true;
    },
  };
}

describe("runLink", () => {
  it("prefers installing the agent plugin and leaves MCP config unchanged on success", async () => {
    const fs = new MemFs();
    const claudeBefore = JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } });
    fs.files.set(HOME_CLAUDE, claudeBefore);
    const messages: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      note(message) {
        messages.push(message);
      },
      outro(message) {
        messages.push(message);
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);

    const manifest = await runLink(ctx, {
      bin: BIN,
      yes: true,
      agentKind: "claude-code",
      installPlugin: async () => ({
        installed: true,
        message: "Ratel Local plugin installed for Claude Code.",
      }),
    });

    expect(manifest).toBeNull();
    expect(fs.files.get(HOME_CLAUDE)).toBe(claudeBefore);
    expect(messages.join("\n")).toMatch(/plugin installed/i);
    expect(messages.join("\n")).toMatch(/reload|restart/i);
  });

  it("explains the plugin failure before applying the MCP fallback", async () => {
    const fs = new MemFs();
    fs.files.set(HOME_CODEX, '[mcp_servers.fs]\ncommand = "echo"\n');
    const messages: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      note(message) {
        messages.push(message);
      },
      outro(message) {
        messages.push(message);
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);

    const manifest = await runLink(ctx, {
      bin: BIN,
      yes: true,
      agentKind: "codex",
      installPlugin: async () => ({
        installed: false,
        message: "codex plugin installation failed: marketplace unavailable",
      }),
    });

    expect(manifest).not.toBeNull();
    expect(fs.files.get(HOME_CODEX)).toContain("[mcp_servers.ratel-local]");
    expect(messages.join("\n")).toMatch(/plugin installation failed/i);
    expect(messages.join("\n")).toMatch(/explicit MCP gateway/i);
    expect(messages.join("\n")).toMatch(/MCP fallback link complete/i);
  });

  it("falls back to MCP config when the plugin installer throws unexpectedly", async () => {
    const fs = new MemFs();
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    const messages: string[] = [];
    const prompts: PromptAdapter = {
      ...autoConfirm(),
      note(message) {
        messages.push(message);
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);

    const manifest = await runLink(ctx, {
      bin: BIN,
      yes: true,
      agentKind: "claude-code",
      installPlugin: async () => {
        throw new Error("unexpected installer crash");
      },
    });

    expect(manifest).not.toBeNull();
    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-local"]).toBeDefined();
    expect(messages.join("\n")).toMatch(/unexpected installer crash/i);
    expect(messages.join("\n")).toMatch(/falling back/i);
  });

  it("does nothing when Claude is already linked through the plugin", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_SETTINGS,
      JSON.stringify({ enabledPlugins: { "ratel-local@ratel": true } }),
    );
    const messages: string[] = [];
    const prompts: PromptAdapter = {
      ...silentPromptAdapter(),
      outro(message) {
        messages.push(message);
      },
    };
    const { ctx } = ctxOf(fs, prompts, false);

    const manifest = await runLink(ctx, { yes: true, agentKind: "claude-code" });

    expect(manifest).toBeNull();
    expect(fs.files.has(HOME_CLAUDE)).toBe(false);
    expect(messages.join("\n")).toMatch(/linked through the Ratel Local plugin/i);
  });

  it("re-enables a disabled Codex plugin MCP instead of adding an explicit gateway", async () => {
    const fs = new MemFs();
    fs.files.set(
      HOME_CODEX,
      `[plugins."ratel-local@ratel"]
enabled = true

[plugins."ratel-local@ratel".mcp_servers.ratel-local]
enabled = false
`,
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    const manifest = await runLink(ctx, { yes: true, agentKind: "codex" });

    expect(manifest).not.toBeNull();
    const codex = fs.files.get(HOME_CODEX) as string;
    expect(codex).toContain(
      `[plugins."ratel-local@ratel".mcp_servers.ratel-local]\nenabled = true`,
    );
    expect(codex).not.toContain("[mcp_servers.ratel-local]");
  });

  it("rolls back every agent config when a later linked scope fails to publish", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-cli-link-transaction-"));
    try {
      const projectRoot = join(homeDir, "repo");
      const claudePath = join(homeDir, ".claude.json");
      const projectMcpPath = join(projectRoot, ".mcp.json");
      const originalClaude = JSON.stringify({ mcpServers: {} });
      const originalProject = JSON.stringify({ mcpServers: {} });
      await mkdir(join(homeDir, ".ratel"), { recursive: true });
      await mkdir(join(projectRoot, ".ratel"), { recursive: true });
      await writeFile(
        join(homeDir, ".ratel", "config.json"),
        JSON.stringify({ mcpServers: { user: { type: "stdio", command: "echo" } } }),
        "utf8",
      );
      await writeFile(
        join(projectRoot, ".ratel", "config.json"),
        JSON.stringify({ mcpServers: { project: { type: "stdio", command: "echo" } } }),
        "utf8",
      );
      await writeFile(claudePath, originalClaude, "utf8");
      await writeFile(projectMcpPath, originalProject, "utf8");
      const mutationEngine = await createMutationEngine({
        controlDir: join(homeDir, ".ratel"),
        hooks: {
          beforeApplyOperation(_operation, index) {
            if (index === 1) throw new Error("fail-project-link-publication");
          },
        },
      });
      const ctx: HandlerCtx = {
        argv: { group: "link", configPaths: [], rest: [], extras: [], flags: {} },
        env: { homeDir, projectRoot },
        fs: nodeFs,
        log: () => {},
        prompts: autoConfirm(),
      };

      await expect(
        runLink(ctx, {
          bin: BIN,
          yes: true,
          agentKind: "claude-code",
          mutationEngine,
        }),
      ).rejects.toThrow("fail-project-link-publication");

      expect(await readFile(claudePath, "utf8")).toBe(originalClaude);
      expect(await readFile(projectMcpPath, "utf8")).toBe(originalProject);
      expect(await readdir(join(homeDir, ".ratel", "transactions"))).toEqual([]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("links an agent when the Ratel scope contains skills but no MCP servers", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        skills: { entries: { review: { mode: "reference", path: "/skills/review" } } },
      }),
    );
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await runLink(ctx, { bin: BIN, yes: true });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
  });

  it("links when the implicit user skill directory has content and config is absent", async () => {
    const fs = new MemFs();
    fs.files.set(
      "/home/u/.ratel/skills/review/SKILL.md",
      "---\nname: review\ndescription: review\n---\n",
    );
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await runLink(ctx, { bin: BIN, yes: true });

    const entry = JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers["ratel-local"];
    expect(entry.args).toEqual(["connect", "--agent-host", "claude-code", "--link-scope", "user"]);
  });

  it("links implicit user skills when an existing config omits skills.dirs", async () => {
    const fs = new MemFs();
    fs.files.set(RATEL_USER, JSON.stringify({ custom: true }));
    fs.files.set(
      "/home/u/.ratel/skills/review/SKILL.md",
      "---\nname: review\ndescription: review\n---\n",
    );
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await runLink(ctx, { bin: BIN, yes: true });

    expect(JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers["ratel-local"]).toBeDefined();
  });

  it("migrates a recognized legacy serve entry to connect", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          "ratel-local": {
            type: "stdio",
            command: "ratel-local",
            args: ["serve", "--config", RATEL_USER],
          },
        },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await runLink(ctx, { bin: BIN, yes: true });

    const entry = JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers["ratel-local"];
    expect(entry.args).toEqual(["connect", "--agent-host", "claude-code", "--link-scope", "user"]);
    expect(entry.args).not.toContain("--config");
  });

  it("preserves an unrelated entry that is merely named ratel", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          ratel: { type: "stdio", command: "company-ratel", args: ["serve"] },
        },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);

    await runLink(ctx, { bin: BIN, yes: true });

    const servers = JSON.parse(fs.files.get(HOME_CLAUDE) as string).mcpServers;
    expect(servers.ratel).toEqual({
      type: "stdio",
      command: "company-ratel",
      args: ["serve"],
    });
    expect(servers["ratel-local"].args[0]).toBe("connect");
  });

  it("writes the Ratel gateway without removing Claude native entries", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: {
          fs: { type: "stdio", command: "echo" },
          other: { type: "stdio", command: "elsewhere" },
        },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });

    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers["ratel-local"]).toEqual({
      type: "stdio",
      command: "ratel-local",
      args: ["connect", "--agent-host", "claude-code", "--link-scope", "user"],
    });
    expect(claude.mcpServers.fs).toEqual({ type: "stdio", command: "echo" });
    expect(claude.mcpServers.other).toEqual({ type: "stdio", command: "elsewhere" });
  });

  it("does not install the Claude Code statusline as part of linking", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });

    expect(fs.files.has("/home/u/.claude/settings.json")).toBe(false);
  });

  it("leaves an existing statusline untouched", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(HOME_CLAUDE, JSON.stringify({ mcpServers: {} }));
    fs.files.set(
      "/home/u/.claude/settings.json",
      JSON.stringify({ statusLine: { type: "command", command: "my-custom-statusline" } }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });

    const settings = JSON.parse(fs.files.get("/home/u/.claude/settings.json") as string);
    expect(settings.statusLine).toEqual({ type: "command", command: "my-custom-statusline" });
  });

  it("does not touch the Ratel global config", async () => {
    const fs = new MemFs();
    const ratelBefore = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    fs.files.set(RATEL_USER, ratelBefore);
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    expect(fs.files.get(RATEL_USER)).toBe(ratelBefore);
  });

  it("links even when no agent entries are also in Ratel", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { other: { type: "stdio", command: "elsewhere" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    const claude = JSON.parse(fs.files.get(HOME_CLAUDE) as string);
    expect(claude.mcpServers.other).toEqual({ type: "stdio", command: "elsewhere" });
    expect(claude.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "user",
    ]);
  });

  it("uses the requested agent instead of the automatic choice", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { claudeOnly: { type: "stdio", command: "claude" } },
      }),
    );
    fs.files.set(
      HOME_CODEX,
      `[mcp_servers.codexOnly]
command = "codex"
`,
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true, agentKind: "codex" });

    expect(fs.files.get(HOME_CLAUDE)).toContain("claudeOnly");
    expect(fs.files.get(HOME_CLAUDE)).not.toContain("ratel-local");
    expect(fs.files.get(HOME_CODEX)).toContain("[mcp_servers.ratel-local]");
    expect(fs.files.get(HOME_CODEX)).toContain(`command = "ratel-local"`);
  });

  it("idempotent: running twice produces no further changes", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    const after1 = fs.files.get(HOME_CLAUDE);
    await runLink(ctx, { bin: BIN, yes: true });
    expect(fs.files.get(HOME_CLAUDE)).toBe(after1);
  });

  it("declines cleanly: leaves Claude untouched when the user says no", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const claudeBefore = JSON.stringify({
      mcpServers: { fs: { type: "stdio", command: "echo" } },
    });
    fs.files.set(HOME_CLAUDE, claudeBefore);
    const decline: PromptAdapter = {
      ...silentPromptAdapter(),
      async confirm() {
        return false;
      },
    };
    const { ctx } = ctxOf(fs, decline, false);
    await runLink(ctx, { bin: BIN });
    expect(fs.files.get(HOME_CLAUDE)).toBe(claudeBefore);
  });

  it("links project scope: rewrites <root>/.mcp.json with the [global, project] arg chain", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_PROJECT,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      PROJECT_MCP,
      JSON.stringify({
        mcpServers: { proj: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm());
    await runLink(ctx, { bin: BIN, yes: true });
    const claudeProj = JSON.parse(fs.files.get(PROJECT_MCP) as string);
    expect(claudeProj.mcpServers["ratel-local"].args).toEqual([
      "connect",
      "--agent-host",
      "claude-code",
      "--link-scope",
      "project",
      "--project-root",
      ROOT,
    ]);
  });

  it("captures a backup before writing", async () => {
    const fs = new MemFs();
    fs.files.set(
      RATEL_USER,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    fs.files.set(
      HOME_CLAUDE,
      JSON.stringify({
        mcpServers: { fs: { type: "stdio", command: "echo" } },
      }),
    );
    const { ctx } = ctxOf(fs, autoConfirm(), false);
    await runLink(ctx, { bin: BIN, yes: true });
    const backupKeys = Array.from(fs.files.keys()).filter((k) =>
      k.startsWith("/home/u/.ratel/backups/"),
    );
    expect(backupKeys.length).toBeGreaterThan(0);
  });
});
