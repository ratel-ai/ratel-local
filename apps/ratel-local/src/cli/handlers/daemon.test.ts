import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
import { projectIdFromCanonicalRoot } from "@ratel-ai/ratel-local-core";
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
  it("exposes retrieval build health only when the experimental health flag is enabled", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {}, retrieval: { method: "bm25" } }),
        processEnv: { RATEL_EXPERIMENTAL_RETRIEVAL_HEALTH: "1" },
      },
      (message) => logs.push(message),
      { open: () => {}, ensureToken: async () => "daemon-test-token" },
    );
    const daemonUrl = daemonUrlFromLogs(logs);

    try {
      const health = await fetch(new URL("/healthz", daemonUrl));
      expect(health.status).toBe(200);
      expect(await health.text()).toBe("ok retrieval=ready\n");

      const status = await fetch(new URL("/api/daemon/status", daemonUrl));
      expect(await status.json()).toMatchObject({
        retrievalHealth: { status: "ready", generations: [] },
      });
    } finally {
      await result.shutdown?.();
    }
  });

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
            version: "0.6.0-rc.0",
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
      version: "0.6.0-rc.0",
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
    const daemonUrl = daemonUrlFromLogs(logs);
    expect(logs.join("\n")).not.toContain("?t=");
    const uiUrl = await mintUiSession(daemonUrl, "daemon-test-token");
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
      retrievalHealth?: unknown;
    };
    expect(status.port).toBe(new URL(uiUrl).port ? Number(new URL(uiUrl).port) : 0);
    expect(status.mcpUrl).toBe(new URL("/mcp", uiUrl).toString());
    expect(status.upstreamCount).toBe(0);
    expect(status.activeClientCount).toBe(0);
    expect(status).not.toHaveProperty("retrievalHealth");

    let openedSessionUrl = "";
    await runDaemon(daemonArgs({ verb: "open", flags: {} }), makeCtx(fs), {}, () => {}, {
      readToken: async () => "daemon-test-token",
      open: (url) => {
        openedSessionUrl = url;
      },
    });
    expect(openedSessionUrl).toMatch(/\/global\/\?t=/);
    const openedUrl = new URL(openedSessionUrl);
    const openedToken = openedUrl.searchParams.get("t");
    expect(
      (
        await fetch(new URL("/api/config", openedUrl), {
          headers: { Authorization: `Bearer ${openedToken}` },
        })
      ).status,
    ).toBe(200);

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
        scopeKey: "global",
        context: { kind: "global" },
        runtimeRevision: "legacy",
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

  it("reconciles registered projects into concurrent runtime generations", async () => {
    const fs = new MemFs();
    const temp = await mkdtemp(join(tmpdir(), "ratel-daemon-control-plane-"));
    const homeDir = join(temp, "home");
    const projectA = await realpath(await mkdtemp(join(temp, "a-")));
    const projectB = await realpath(await mkdtemp(join(temp, "b-")));
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await mkdir(join(projectA, ".ratel"), { recursive: true });
    await mkdir(join(projectB, ".ratel"), { recursive: true });
    await writeFile(
      join(homeDir, ".ratel", "config.json"),
      JSON.stringify({ mcpServers: {}, skills: { dirs: [] } }),
    );
    const writeProject = (root: string, command: string) =>
      writeFile(
        join(root, ".ratel", "config.json"),
        JSON.stringify({ mcpServers: { scoped: { type: "stdio", command } } }),
      );
    await writeProject(projectA, "project-a-v1");
    await writeProject(projectB, "project-b-v1");

    const upstreams: Server[] = [];
    const runtimeInputs: Array<{ command?: string; cwd?: string; oauthStorePath?: string }> = [];
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs({
        configPaths: [],
        flags: { open: false, telemetry: "off", port: "0", "auto-config": true },
      }),
      makeCtx(fs, { homeDir }),
      {
        transportFactory: (_name, entry, runtime) => {
          runtimeInputs.push({ command: entry.command, ...runtime });
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
    const uiToken = new URL(await mintUiSession(daemonUrl, "daemon-test-token")).searchParams.get(
      "t",
    );

    const connect = async (projectRoot: string, name: string) => {
      const client = new Client({ name, version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL("/mcp", daemonUrl), {
          requestInit: { headers: connectorHeaders("daemon-test-token", projectRoot) },
        }),
      );
      return client;
    };

    const oldA = await connect(projectA, "project-a-old");
    const clientB = await connect(projectB, "project-b");
    await writeProject(projectA, "project-a-v2");
    const newA = await connect(projectA, "project-a-new");
    try {
      const oldSearch = await oldA.callTool({
        name: "search_capabilities",
        arguments: { query: "project-a-v1" },
      });
      const newSearch = await newA.callTool({
        name: "search_capabilities",
        arguments: { query: "project-a-v2" },
      });
      const bSearch = await clientB.callTool({
        name: "search_capabilities",
        arguments: { query: "project-b-v1" },
      });
      expect(JSON.stringify(oldSearch.content)).toContain("project-a-v1_tool");
      expect(JSON.stringify(newSearch.content)).toContain("project-a-v2_tool");
      expect(JSON.stringify(bSearch.content)).toContain("project-b-v1_tool");

      expect(runtimeInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: "project-a-v1", cwd: projectA }),
          expect.objectContaining({ command: "project-a-v2", cwd: projectA }),
          expect.objectContaining({ command: "project-b-v1", cwd: projectB }),
        ]),
      );
      expect(new Set(runtimeInputs.map((runtime) => runtime.oauthStorePath)).size).toBe(2);

      const clientsUrl = new URL("/api/mcp-clients", daemonUrl);
      clientsUrl.searchParams.set("projectId", projectIdFromCanonicalRoot(projectA));
      const clientsResponse = await fetch(clientsUrl, {
        headers: { Authorization: `Bearer ${uiToken}` },
      });
      const clientsBody = (await clientsResponse.json()) as {
        clients: Array<{ name: string; runtimeRevision: string; stale: boolean }>;
      };
      expect(clientsBody.clients.find((client) => client.name === "project-a-old")?.stale).toBe(
        true,
      );
      expect(clientsBody.clients.find((client) => client.name === "project-a-new")?.stale).toBe(
        false,
      );
    } finally {
      await oldA.close();
      await newA.close();
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
        "@ratel-ai/ratel-local@0.6.0-rc.0",
      ],
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });

    expect(plist).toContain("<string>/opt/node/bin/node</string>");
    expect(plist).toContain("<string>/opt/node/lib/node_modules/npm/bin/npx-cli.js</string>");
    expect(plist.indexOf("@ratel-ai/ratel-local@0.6.0-rc.0")).toBeLessThan(
      plist.indexOf("<string>daemon</string>"),
    );
  });

  it("preserves the install-time PATH for macOS upstream commands", () => {
    const plist = createLaunchAgentPlist({
      executablePath: "/opt/node/bin/node",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      pathEnv: "/opt/node/bin:/usr/bin:/bin",
    });

    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/node/bin:/usr/bin:/bin</string>");
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
        "@ratel-ai/ratel-local@0.6.0-rc.0",
      ],
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });

    expect(service).toContain(
      "ExecStart=/opt/node/bin/node /opt/node/lib/node_modules/npm/bin/npx-cli.js -y @ratel-ai/ratel-local@0.6.0-rc.0 daemon run",
    );
  });

  it("preserves the install-time PATH for Linux upstream commands", () => {
    const service = createSystemdUserService({
      executablePath: "/opt/node/bin/node",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      pathEnv: "/opt/node/bin:/usr/bin:/bin",
    });

    expect(service).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin");
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

async function mintUiSession(daemonUrl: string, daemonToken: string): Promise<string> {
  const response = await fetch(new URL("/api/ui/sessions", daemonUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!response.ok) throw new Error(`unable to mint test UI session: ${response.status}`);
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("daemon returned no UI session URL");
  return body.url;
}
