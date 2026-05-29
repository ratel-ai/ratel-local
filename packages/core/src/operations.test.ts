import { describe, expect, it } from "vitest";
import type { BackupFs } from "./backup.js";
import type { JsonFs } from "./io.js";
import {
  addServerEntry,
  editServerEntry,
  getConfigState,
  importAgentServers,
  linkAgentToRatel,
  removeServerEntry,
} from "./operations.js";

const HOME = "/home/u";
const ROOT = "/repo";
const USER_PATH = "/home/u/.ratel/config.json";
const CLAUDE_PATH = "/home/u/.claude.json";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();

  async read(path: string) {
    return this.files.get(path) ?? null;
  }

  async write(path: string, contents: string) {
    this.files.set(path, contents);
  }

  async writeAtomic(path: string, contents: string) {
    this.files.set(path, contents);
  }

  async remove(path: string) {
    this.files.delete(path);
  }

  async mkdirp() {}

  async exists(path: string) {
    return this.files.has(path);
  }

  async list(path: string) {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash >= 0 ? rest.slice(0, slash) : rest);
    }
    return Array.from(names);
  }
}

function ctx(fs = new MemFs()) {
  return { env: { homeDir: HOME, projectRoot: ROOT }, fs, log: () => {} };
}

describe("core operations — server entries", () => {
  it("adds, edits, and removes entries with backups", async () => {
    const fs = new MemFs();
    await addServerEntry(ctx(fs), {
      scope: "user",
      name: "fs",
      entry: { type: "stdio", command: "echo" },
    });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");

    await editServerEntry(ctx(fs), {
      scope: "user",
      name: "fs",
      entry: { type: "stdio", command: "node", args: ["server.js"] },
    });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.args).toEqual(["server.js"]);

    await removeServerEntry(ctx(fs), { scope: "user", name: "fs" });
    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers).toEqual({});
    expect([...fs.files.keys()].some((path) => path.includes("/.ratel/backups/"))).toBe(true);
  });
});

describe("core operations — config state", () => {
  it("reports scope configs and auth status", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({
        mcpServers: {
          local: { type: "stdio", command: "echo" },
          remote: { type: "http", url: "https://example.com/mcp" },
          expired: { type: "http", url: "https://expired.example/mcp" },
          ready: { type: "http", url: "https://ready.example/mcp" },
        },
      }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/expired.json`,
      JSON.stringify({ tokens: { access_token: "x" }, expires_at: Date.now() - 1000 }),
    );
    fs.files.set(
      `${HOME}/.ratel/oauth/ready.json`,
      JSON.stringify({ tokens: { access_token: "x" }, expires_at: Date.now() + 100000 }),
    );

    const state = await getConfigState(ctx(fs));
    expect(state.scopes.user.available).toBe(true);
    if (!state.scopes.user.available) throw new Error("expected user scope");
    expect(state.scopes.user.authStatus.local).toBe("n/a");
    expect(state.scopes.user.authStatus.remote).toBe("needs auth");
    expect(state.scopes.user.authStatus.expired).toBe("expired");
    expect(state.scopes.user.authStatus.ready).toBe("ok");
  });
});

describe("core operations — agent interop", () => {
  it("imports Claude Code entries non-interactively", async () => {
    const fs = new MemFs();
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    await importAgentServers(ctx(fs), { envVar: "/usr/local/bin/ratel-mcp" });

    expect(JSON.parse(fs.files.get(USER_PATH) as string).mcpServers.fs.command).toBe("echo");
    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-mcp"].command).toBe("/usr/local/bin/ratel-mcp");
  });

  it("links matching Claude Code entries non-interactively", async () => {
    const fs = new MemFs();
    fs.files.set(
      USER_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );
    fs.files.set(
      CLAUDE_PATH,
      JSON.stringify({ mcpServers: { fs: { type: "stdio", command: "echo" } } }),
    );

    await linkAgentToRatel(ctx(fs), { envVar: "/usr/local/bin/ratel-mcp" });

    const claude = JSON.parse(fs.files.get(CLAUDE_PATH) as string);
    expect(claude.mcpServers.fs).toBeUndefined();
    expect(claude.mcpServers["ratel-mcp"].args).toContain(USER_PATH);
  });
});
