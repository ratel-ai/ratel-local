import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import { runDaemon } from "./daemon.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/repo";

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

function daemonArgs(input: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    group: "daemon",
    configPaths: ["/config.json"],
    rest: [],
    extras: [],
    flags: { open: false, telemetry: "off" },
    ...input,
  };
}

function makeCtx(fs: MemFs, env: HierarchyEnv = { homeDir: HOME, projectRoot: ROOT }): HandlerCtx {
  return {
    argv: daemonArgs(),
    env,
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
}

describe("runDaemon", () => {
  it("serves MCP over HTTP and lists active initialized clients in the UI API", async () => {
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(new MemFs()),
      {
        readConfig: async () => ({
          mcpServers: {},
          skills: { dirs: ["/nonexistent-ratel-daemon-test-skills"] },
        }),
      },
      (message) => logs.push(message),
      { open: () => {} },
    );
    const uiUrl = daemonUrlFromLogs(logs);
    const token = new URL(uiUrl).searchParams.get("t");
    expect(token).toBeTruthy();

    const mcpUrl = new URL("/mcp", uiUrl);
    const client = new Client({ name: "daemon-test-client", version: "1.0.0" });

    try {
      await client.connect(new StreamableHTTPClientTransport(mcpUrl));
      await client.listTools();

      const res = await fetch(new URL("/api/mcp-clients", uiUrl), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        clients: Array<{ name: string; version: string; requestCount: number }>;
      };
      expect(body.clients).toHaveLength(1);
      expect(body.clients[0]).toMatchObject({
        name: "daemon-test-client",
        version: "1.0.0",
      });
      expect(body.clients[0].requestCount).toBeGreaterThanOrEqual(1);
    } finally {
      await client.close();
      await result.shutdown();
    }
  });
});

function daemonUrlFromLogs(logs: string[]): string {
  const line = logs.find((message) => message.includes("daemon running at"));
  if (!line) throw new Error(`daemon URL log not found in: ${logs.join("\n")}`);
  const match = /https?:\/\/\S+/.exec(line);
  if (!match) throw new Error(`daemon URL missing from log: ${line}`);
  return match[0];
}
