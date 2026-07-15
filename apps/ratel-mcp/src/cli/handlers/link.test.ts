import type { BackupFs, JsonFs, ResolvedBin } from "@ratel-ai/mcp-core";
import { describe, expect, it } from "vitest";
import { type PromptAdapter, silentPromptAdapter } from "../prompts.js";
import { runLink } from "./link.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/r";
const BIN: ResolvedBin = { command: "ratel-mcp", args: [], source: "path" };

const HOME_CLAUDE = "/home/u/.claude.json";
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
      prompts,
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
    expect(claude.mcpServers["ratel-mcp"]).toEqual({
      type: "stdio",
      command: "ratel-mcp",
      args: ["serve", "--config", RATEL_USER],
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
    expect(claude.mcpServers["ratel-mcp"].args).toEqual(["serve", "--config", RATEL_USER]);
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
    expect(fs.files.get(HOME_CLAUDE)).not.toContain("ratel-mcp");
    expect(fs.files.get(HOME_CODEX)).toContain("[mcp_servers.ratel-mcp]");
    expect(fs.files.get(HOME_CODEX)).toContain(`command = "ratel-mcp"`);
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
    expect(claudeProj.mcpServers["ratel-mcp"].args).toEqual([
      "serve",
      "--config",
      RATEL_USER,
      "--config",
      RATEL_PROJECT,
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
