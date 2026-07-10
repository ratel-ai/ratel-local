import { describe, expect, it } from "vitest";
import type { ServerEntry } from "../lib/index.js";
import { parseCodexMcpServers, rewriteCodexConfig } from "./codex.js";

function envRef(name: string): string {
  return ["$", `{${name}}`].join("");
}

function gatewayEntry(entry: ServerEntry) {
  return { name: "ratel-local" as const, entry };
}

describe("Codex agent host helpers", () => {
  it("reads stdio and http MCP entries from Codex config.toml", () => {
    const entries = parseCodexMcpServers(`
[mcp_servers.fs]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
enabled = true

[mcp_servers.remote]
url = "https://mcp.example.com"
enabled = true
`);

    expect(entries.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: undefined,
    });
    expect(entries.remote).toEqual({ type: "http", url: "https://mcp.example.com" });
  });

  it("keeps nested server tables attached to their parent MCP entry", () => {
    const entries = parseCodexMcpServers(`
[mcp_servers.fs]
command = "node"
args = ["server.js"]
enabled = false

[mcp_servers.fs.env]
TOKEN = "secret"
REGION = "eu"

[mcp_servers.ratel-local]
command = "ratel-local"
args = ["serve", "--config", "/home/u/.ratel/config.json"]

[mcp_servers.ratel-local.tools.search_capabilities]
enabled = true
`);

    expect(entries.fs).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { TOKEN: "secret", REGION: "eu" },
    });
    expect(entries["fs.env"]).toBeUndefined();
    expect(entries["ratel-local.tools.search_capabilities"]).toBeUndefined();
    expect(entries["ratel-local"]?.args).toEqual([
      "serve",
      "--config",
      "/home/u/.ratel/config.json",
    ]);
  });

  it("reads full TOML syntax for stdio args, env, and cwd", () => {
    const entries = parseCodexMcpServers(`
[mcp_servers.fs]
command = "node"
args = [
  "server.js",
  "--root",
  "/tmp",
]
cwd = "/repo"
env = { TOKEN = "secret", REGION = "eu" }
`);

    expect(entries.fs).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js", "--root", "/tmp"],
      env: { TOKEN: "secret", REGION: "eu" },
      cwd: "/repo",
    });
  });

  it("maps Codex HTTP auth into existing Ratel header fields", () => {
    const entries = parseCodexMcpServers(`
[mcp_servers.remote]
url = "https://mcp.example.com"
bearer_token_env_var = "MCP_TOKEN"
scopes = ["read", "write"]
oauth_resource = "https://mcp.example.com"

[mcp_servers.remote.http_headers]
X-Static = "static"

[mcp_servers.remote.env_http_headers]
X-API-Key = "MCP_API_KEY"

[mcp_servers.remote.oauth]
client_id = "client-123"
`);

    expect(entries.remote).toEqual({
      type: "http",
      url: "https://mcp.example.com",
      headers: {
        "X-Static": "static",
        "X-API-Key": envRef("MCP_API_KEY"),
        Authorization: `Bearer ${envRef("MCP_TOKEN")}`,
      },
      clientId: "client-123",
      scope: "read write",
    });
  });

  it("removes covered native entries and installs ratel-local", () => {
    const gateway: ServerEntry = {
      type: "stdio",
      command: "ratel-local",
      args: ["serve", "--config", "/home/u/.ratel/config.json"],
    };
    const next = rewriteCodexConfig(
      `
model = "gpt-5.3-codex"

[mcp_servers.fs]
command = "npx"
args = ["-y", "fs"]

[mcp_servers.keep]
command = "node"
args = ["keep.js"]
`,
      new Set(["fs"]),
      gatewayEntry(gateway),
    );

    expect(next).not.toContain("[mcp_servers.fs]");
    expect(next).toContain("[mcp_servers.keep]");
    expect(next).toContain("[mcp_servers.ratel-local]");
    expect(next).toContain('args = ["serve","--config","/home/u/.ratel/config.json"]');
  });

  it("removes nested tables for replaced entries while preserving unrelated tables", () => {
    const gateway: ServerEntry = {
      type: "stdio",
      command: "ratel-local",
      args: ["serve", "--config", "/home/u/.ratel/config.json"],
    };
    const next = rewriteCodexConfig(
      `
[mcp_servers.fs]
command = "node"

[mcp_servers.fs.env]
TOKEN = "secret"

[projects."/repo"]
trusted = true

[mcp_servers.keep]
command = "node"

[mcp_servers.keep.env]
TOKEN = "keep"
`,
      new Set(["fs"]),
      gatewayEntry(gateway),
    );

    expect(next).not.toContain("[mcp_servers.fs]");
    expect(next).not.toContain("[mcp_servers.fs.env]");
    expect(next).toContain('[projects."/repo"]');
    expect(next).toContain("[mcp_servers.keep]");
    expect(next).toContain("[mcp_servers.keep.env]");
  });

  it("removes nested tool tables when replacing an existing ratel-local entry", () => {
    const gateway: ServerEntry = {
      type: "stdio",
      command: "ratel-local",
      args: ["serve", "--config", "/home/u/.ratel/config.json"],
    };
    const next = rewriteCodexConfig(
      `
[mcp_servers.ratel-local]
command = "ratel-local"
args = ["serve", "--config", "/old.json"]

[mcp_servers.ratel-local.tools.search_capabilities]
enabled = true
`,
      new Set(["fs"]),
      gatewayEntry(gateway),
    );

    expect(next).not.toContain("/old.json");
    expect(next).not.toContain("[mcp_servers.ratel-local.tools.search_capabilities]");
    expect(next.match(/\[mcp_servers\.ratel-local\]/g)).toHaveLength(1);
  });

  it("rewrites valid inline TOML server definitions with a structured fallback", () => {
    const gateway: ServerEntry = {
      type: "stdio",
      command: "ratel-local",
      args: ["serve", "--config", "/home/u/.ratel/config.json"],
    };
    const next = rewriteCodexConfig(
      `
model = "gpt-5.3-codex"
mcp_servers = { fs = { command = "node", args = ["fs.js"] }, keep = { command = "node", args = ["keep.js"] } }
`,
      new Set(["fs"]),
      gatewayEntry(gateway),
    );

    const entries = parseCodexMcpServers(next);
    expect(entries.fs).toBeUndefined();
    expect(entries.keep).toEqual({ type: "stdio", command: "node", args: ["keep.js"] });
    expect(entries["ratel-local"]?.args).toEqual([
      "serve",
      "--config",
      "/home/u/.ratel/config.json",
    ]);
  });
});
