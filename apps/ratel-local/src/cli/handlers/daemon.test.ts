import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import { connectorHeaders } from "../../daemon/access.js";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import {
  createLaunchAgentPlist,
  createSystemdUserService,
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  inspectDaemonService,
  runDaemon,
  SYSTEMD_SERVICE,
} from "./daemon.js";
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
    flags: { open: false, telemetry: "off", port: "0" },
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
  it("reports an installed service as stopped when its health probe is offline", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, "<plist />");

    await expect(
      inspectDaemonService(daemonArgs({ flags: {} }), makeCtx(fs), {
        platform: "darwin",
        probe: async () => ({ ok: false, error: "offline" }),
      }),
    ).resolves.toEqual({ state: "stopped", port: DEFAULT_DAEMON_PORT });
  });

  it("reports the running daemon package version for setup compatibility checks", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, "<plist />");

    await expect(
      inspectDaemonService(daemonArgs({ flags: {} }), makeCtx(fs), {
        platform: "darwin",
        probe: async (port) => ({
          ok: true,
          status: {
            pid: 123,
            port,
            uiUrl: `http://127.0.0.1:${port}`,
            mcpUrl: `http://127.0.0.1:${port}/mcp`,
            startedAt: "2026-07-10T08:00:00.000Z",
            version: "0.5.0-rc.0",
            configMode: "auto",
            uptimeSeconds: 10,
            upstreamCount: 0,
            activeClientCount: 0,
            activeGatewayCount: 0,
            activeUserGatewayCount: 0,
            activeProjectGatewayCount: 0,
          },
        }),
      }),
    ).resolves.toEqual({
      state: "running",
      port: DEFAULT_DAEMON_PORT,
      version: "0.5.0-rc.0",
    });
  });

  it("serves MCP, health, daemon status, and active initialized clients in the UI API", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({
          mcpServers: {},
          skills: { dirs: ["/nonexistent-ratel-daemon-test-skills"] },
        }),
      },
      (message) => logs.push(message),
      { open: () => {}, ensureToken: async () => "daemon-test-token" },
    );
    const uiUrl = daemonUrlFromLogs(logs);
    const token = new URL(uiUrl).searchParams.get("t");
    expect(token).toBeTruthy();

    const healthRes = await fetch(new URL("/healthz", uiUrl));
    expect(healthRes.status).toBe(200);
    expect(await healthRes.text()).toBe("ok\n");

    const unauthorized = await fetch(new URL("/mcp", uiUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "unauthorized", version: "1.0.0" },
        },
      }),
    });
    expect(unauthorized.status).toBe(401);

    const statusRes = await fetch(new URL("/api/daemon/status", uiUrl));
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      port: number;
      mcpUrl: string;
      upstreamCount: number;
      activeClientCount: number;
    };
    expect(status.port).toBe(new URL(uiUrl).port ? Number(new URL(uiUrl).port) : 0);
    expect(status.mcpUrl).toBe(new URL("/mcp", uiUrl).toString());
    expect(status.upstreamCount).toBe(0);
    expect(status.activeClientCount).toBe(0);

    const state = JSON.parse(fs.files.get(`${HOME}/.ratel/daemon.json`) ?? "{}") as {
      port?: number;
      uiUrl?: string;
      mcpUrl?: string;
      configMode?: string;
    };
    expect(state.port).toBe(status.port);
    expect(state.uiUrl).toBe(`http://127.0.0.1:${status.port}`);
    expect(state.mcpUrl).toBe(status.mcpUrl);
    expect(state.configMode).toBe("explicit");

    const mcpUrl = new URL("/mcp", uiUrl);
    const client = new Client({ name: "daemon-test-client", version: "1.0.0" });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(mcpUrl, {
          requestInit: { headers: connectorHeaders("daemon-test-token") },
        }),
      );
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
        scope: "user",
        scopeKey: "user",
      });
      expect(body.clients[0].requestCount).toBeGreaterThanOrEqual(1);

      const nextStatusRes = await fetch(new URL("/api/daemon/status", uiUrl));
      const nextStatus = (await nextStatusRes.json()) as { activeClientCount: number };
      expect(nextStatus.activeClientCount).toBe(1);
    } finally {
      await client.close();
      await result.shutdown();
    }
  });

  it("isolates project config chains while sharing one daemon", async () => {
    const fs = new MemFs();
    const temp = await mkdtemp(join(tmpdir(), "ratel-daemon-scopes-"));
    const projectA = await realpath(await mkdtemp(join(temp, "a-")));
    const projectB = await realpath(await mkdtemp(join(temp, "b-")));
    const upstreams: Server[] = [];
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs({
        configPaths: [],
        flags: { open: false, telemetry: "off", port: "0", "auto-config": true },
      }),
      makeCtx(fs, { homeDir: HOME }),
      {
        readConfig: async (path) => {
          const command = path.startsWith(projectA)
            ? "project-a"
            : path.startsWith(projectB)
              ? "project-b"
              : "user";
          return { mcpServers: { scoped: { type: "stdio", command } } };
        },
        transportFactory: (_name, entry) => {
          const command = entry.command ?? "unknown";
          const server = new Server(
            { name: command, version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
              {
                name: `${command}_tool`,
                description: `${command} capability`,
                inputSchema: { type: "object" },
              },
            ],
          }));
          server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));
          const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
          upstreams.push(server);
          void server.connect(serverTransport);
          return clientTransport;
        },
      },
      (message) => logs.push(message),
      { open: () => {}, ensureToken: async () => "daemon-test-token" },
    );
    const daemonUrl = daemonUrlFromLogs(logs);

    const connect = async (projectRoot: string) => {
      const client = new Client({ name: "scope-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", daemonUrl), {
          requestInit: { headers: connectorHeaders("daemon-test-token", projectRoot) },
        }),
      );
      return client;
    };
    const clientA = await connect(projectA);
    const clientB = await connect(projectB);
    try {
      const searchA = await clientA.callTool({
        name: "search_capabilities",
        arguments: { query: "project-a" },
      });
      const searchB = await clientB.callTool({
        name: "search_capabilities",
        arguments: { query: "project-b" },
      });
      const textA = (searchA.content as Array<{ text: string }>)[0].text;
      const textB = (searchB.content as Array<{ text: string }>)[0].text;
      expect(textA).toContain("scoped__project-a_tool");
      expect(textA).not.toContain("project-b_tool");
      expect(textB).toContain("scoped__project-b_tool");
      expect(textB).not.toContain("project-a_tool");

      const status = await fetch(new URL("/api/daemon/status", daemonUrl));
      expect(await status.json()).toMatchObject({
        activeGatewayCount: 2,
        activeProjectGatewayCount: 2,
      });
    } finally {
      await clientA.close();
      await clientB.close();
      await result.shutdown();
      await Promise.all(upstreams.map((server) => server.close()));
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("generates the macOS LaunchAgent plist for the stable daemon port", () => {
    const plist = createLaunchAgentPlist({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });
    expect(plist).toContain("<string>ai.ratel.local.daemon</string>");
    expect(plist).toContain("<string>/opt/bin/ratel-local</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>5731</string>");
    expect(plist).toContain("<string>--no-open</string>");
    expect(plist).toContain("<string>--auto-config</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/home/u/.ratel/logs/daemon.log</string>");
  });

  it("preserves a stable package-runner prefix in the macOS service", () => {
    const plist = createLaunchAgentPlist({
      executablePath: "/opt/node/bin/node",
      executableArgs: [
        "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
        "-y",
        "@ratel-ai/ratel-local@0.5.0-rc.0",
      ],
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });

    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/node/lib/node_modules/npm/bin/npx-cli.js</string>");
    expect(plist.indexOf("@ratel-ai/ratel-local@0.5.0-rc.0")).toBeLessThan(
      plist.indexOf("<string>daemon</string>"),
    );
  });

  it("installs the macOS daemon LaunchAgent and probes the stable port", async () => {
    const fs = new MemFs();
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    await runDaemon(
      daemonArgs({ verb: "install", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      {},
      (message) => logs.push(message),
      {
        platform: "darwin",
        executablePath: "/opt/bin/ratel-local",
        getUid: () => 501,
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: async (port) => ({ ok: port === DEFAULT_DAEMON_PORT }),
      },
    );

    const paths = daemonPaths(HOME);
    expect(fs.files.get(paths.plist)).toContain("<string>/opt/bin/ratel-local</string>");
    expect(commands).toEqual([
      { command: "launchctl", args: ["bootstrap", "gui/501", paths.plist] },
      { command: "launchctl", args: ["kickstart", "-k", "gui/501/ai.ratel.local.daemon"] },
    ]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:5731/mcp");
  });

  it("generates the Linux user systemd service for the stable daemon port", () => {
    const service = createSystemdUserService({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });
    expect(service).toContain("Description=Ratel Local daemon");
    expect(service).toContain(
      "ExecStart=/opt/bin/ratel-local daemon run --port 5731 --no-open --auto-config",
    );
    expect(service).toContain("WorkingDirectory=/home/u");
    expect(service).toContain("Restart=always");
    expect(service).toContain("StandardOutput=append:/home/u/.ratel/logs/daemon.log");
    expect(service).toContain("WantedBy=default.target");
  });

  it("preserves a stable package-runner prefix in the Linux service", () => {
    const service = createSystemdUserService({
      executablePath: "/opt/node/bin/node",
      executableArgs: [
        "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
        "-y",
        "@ratel-ai/ratel-local@0.5.0-rc.0",
      ],
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });

    expect(service).toContain(
      "ExecStart=/opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npx-cli.js -y @ratel-ai/ratel-local@0.5.0-rc.0 daemon run",
    );
  });

  it("installs the Linux user systemd service and probes the stable port", async () => {
    const fs = new MemFs();
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    await runDaemon(
      daemonArgs({ verb: "install", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      {},
      (message) => logs.push(message),
      {
        platform: "linux",
        executablePath: "/opt/bin/ratel-local",
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: async (port) => ({ ok: port === DEFAULT_DAEMON_PORT }),
      },
    );

    const paths = daemonPaths(HOME);
    expect(fs.files.get(paths.systemdService)).toContain("ExecStart=/opt/bin/ratel-local");
    expect(commands).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_SERVICE] },
    ]);
    expect(logs.join("\n")).toContain("http://127.0.0.1:5731/mcp");
  });

  it("reports daemon status from the persisted state and live probe", async () => {
    const fs = new MemFs();
    fs.files.set(
      `${HOME}/.ratel/daemon.json`,
      JSON.stringify({
        pid: 123,
        port: DEFAULT_DAEMON_PORT,
        uiUrl: "http://127.0.0.1:5731",
        mcpUrl: "http://127.0.0.1:5731/mcp",
        startedAt: "2026-07-01T08:00:00.000Z",
        version: "0.3.1",
        configMode: "auto",
      }),
    );
    const logs: string[] = [];

    await runDaemon(
      daemonArgs({ verb: "status", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      {},
      (message) => logs.push(message),
      {
        probe: async (port) => ({
          ok: true,
          status: {
            pid: 123,
            port,
            uiUrl: "http://127.0.0.1:5731",
            mcpUrl: "http://127.0.0.1:5731/mcp",
            startedAt: "2026-07-01T08:00:00.000Z",
            version: "0.3.1",
            configMode: "auto",
            uptimeSeconds: 10,
            upstreamCount: 2,
            activeClientCount: 1,
            activeGatewayCount: 1,
            activeUserGatewayCount: 1,
            activeProjectGatewayCount: 0,
          },
        }),
      },
    );

    expect(logs.join("\n")).toContain("daemon running at http://127.0.0.1:5731");
    expect(logs.join("\n")).toContain("2 upstream server(s), 1 active MCP client(s)");
  });
});

function daemonUrlFromLogs(logs: string[]): string {
  const line = logs.find((message) => message.includes("daemon running at"));
  if (!line) throw new Error(`daemon URL log not found in: ${logs.join("\n")}`);
  const match = /https?:\/\/\S+/.exec(line);
  if (!match) throw new Error(`daemon URL missing from log: ${line}`);
  return match[0];
}
