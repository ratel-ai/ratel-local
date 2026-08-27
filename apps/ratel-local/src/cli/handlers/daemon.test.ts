import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
import { projectIdFromCanonicalRoot } from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { connectorHeaders } from "../../daemon/access.js";
import { CLOUD_TELEMETRY_FEATURE_ENV } from "../../feature-flags.js";
import type { ParsedArgs } from "../args.js";
import { silentPromptAdapter } from "../prompts.js";
import {
  createLaunchAgentPlist,
  createSystemdUserService,
  DAEMON_INSTALL_PATH_ENV,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SERVICE_ID,
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  inspectDaemonService,
  runDaemon,
  SYSTEMD_SERVICE,
  waitForDaemonStopped,
} from "./daemon.js";
import { createTestPreparedChanges } from "./test-prepared-changes.js";
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
  it("derives both native exporter plans from the live daemon port", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-daemon-agent-traces-"));
    const fs = new MemFs();
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs({ configPaths: [], flags: { open: false, telemetry: "off", port: "0" } }),
      makeCtx(fs, { homeDir }),
      { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        preparedChanges: createTestPreparedChanges(makeCtx(fs, { homeDir }).fs),
        cloudSettingsStore: { load: async () => undefined, save: async () => {} },
      },
    );
    try {
      const daemonUrl = daemonUrlFromLogs(logs);
      const uiUrl = await mintUiSession(daemonUrl, "daemon-test-token");
      const token = new URL(uiUrl).searchParams.get("t") ?? "";
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const expectedEndpoint = new URL("/otlp/v1/traces", daemonUrl).toString();

      const statusResponse = await fetch(new URL("/api/agent-traces", daemonUrl), { headers });
      expect(statusResponse.status).toBe(200);
      expect(await statusResponse.json()).toMatchObject({
        endpoint: expectedEndpoint,
        cloudConfigured: false,
        featureEnabled: true,
        cloudCredentialSource: "none",
      });

      const prepareResponse = await fetch(new URL("/api/agent-traces/prepare", daemonUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "enable",
          hostKinds: ["claude-code", "codex"],
          overwrite: false,
        }),
      });
      expect(prepareResponse.status).toBe(200);
      const prepared = (await prepareResponse.json()) as { changeId: string };
      const commitResponse = await fetch(
        new URL(`/api/changes/${encodeURIComponent(prepared.changeId)}/commit`, daemonUrl),
        { method: "POST", headers },
      );
      expect(commitResponse.status).toBe(200);
      expect(fs.files.get(join(homeDir, ".claude", "settings.json"))).toContain(expectedEndpoint);
      expect(fs.files.get(join(homeDir, ".codex", "config.toml"))).toContain(expectedEndpoint);

      // Reported "none" above. A UI save has to move it, or `traces status`
      // shows a configured relay next to a credential that came from nowhere.
      await fetch(new URL("/api/cloud-traces", daemonUrl), {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          endpoint: "https://cloud.example.test/api/v1/traces",
          apiKey: "saved-cloud-secret",
        }),
      });
      const afterSave = await fetch(new URL("/api/agent-traces", daemonUrl), { headers });
      expect(await afterSave.json()).toMatchObject({
        cloudConfigured: true,
        cloudCredentialSource: 'profile "default" (saved in the UI)',
      });
    } finally {
      await result.shutdown?.();
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("mounts configured Cloud OTLP trace and log relays on the loopback daemon", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const shutdownRatelTelemetry = vi.fn(async () => {});
    const configureRatelTelemetry = vi.fn(async () => ({ shutdown: shutdownRatelTelemetry }));
    const cloudFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloud-test-secret");
      return new Response(Buffer.from([0x00]), {
        status: 200,
        headers: { "Content-Type": "application/x-protobuf" },
      });
    });
    const daemonProcessEnv = {
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
      RATEL_CLOUD_OTLP_TRACES_ENDPOINT: "https://cloud.example.test/otlp/v1/traces",
      RATEL_API_KEY: "cloud-test-secret",
    };
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: daemonProcessEnv,
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudOtlpFetch: cloudFetch,
        configureRatelTelemetry,
      },
    );
    const daemonUrl = new URL(daemonUrlFromLogs(logs));

    try {
      expect(daemonUrl.hostname).toBe("127.0.0.1");
      const response = await fetch(new URL("/otlp/v1/traces", daemonUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(response.status).toBe(200);
      expect(cloudFetch).toHaveBeenCalledOnce();

      const logPayload = Buffer.from([0x12, 0x03, 0x6c, 0x6f, 0x67]);
      const logsResponse = await fetch(new URL("/otlp/v1/logs", daemonUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: logPayload,
      });
      expect(logsResponse.status).toBe(200);
      expect(cloudFetch).toHaveBeenCalledTimes(2);
      expect(String(cloudFetch.mock.calls[1]?.[0])).toBe("https://cloud.example.test/otlp/v1/logs");
      expect(Buffer.from((cloudFetch.mock.calls[1]?.[1]?.body as Uint8Array) ?? [])).toEqual(
        logPayload,
      );

      const rejectedHostStatus = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: Number(daemonUrl.port),
            path: "/otlp/v1/traces",
            method: "POST",
            headers: {
              Host: "evil.example.test:5731",
              "Content-Type": "application/x-protobuf",
              "Content-Length": "2",
            },
          },
          (rawResponse) => {
            rawResponse.resume();
            resolve(rawResponse.statusCode ?? 0);
          },
        );
        request.once("error", reject);
        request.end(Buffer.from([0x0a, 0x00]));
      });
      expect(rejectedHostStatus).toBe(400);
      expect(cloudFetch).toHaveBeenCalledTimes(2);
      expect(logs.join("\n")).toContain("Cloud OTLP trace endpoint available");
      expect(logs.join("\n")).toContain("Cloud OTLP log endpoint available");
      expect(logs.join("\n")).not.toContain("cloud-test-secret");
      expect([...fs.files.values()].join("\n")).not.toContain("cloud-test-secret");
      expect(daemonProcessEnv).not.toHaveProperty("RATEL_API_KEY");
      expect(configureRatelTelemetry).toHaveBeenCalledWith({
        endpoint: new URL("/otlp/v1/traces", daemonUrl).toString(),
        serviceName: "ratel-local",
      });
    } finally {
      await result.shutdown?.();
    }
    expect(shutdownRatelTelemetry).toHaveBeenCalledOnce();
  });

  it("keeps the daemon available and removes its credential when Ratel telemetry initialization fails", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const daemonProcessEnv = {
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
      RATEL_CLOUD_OTLP_TRACES_ENDPOINT: "https://cloud.example.test/otlp/v1/traces",
      RATEL_API_KEY: "cloud-test-secret",
    };

    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: daemonProcessEnv,
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        configureRatelTelemetry: async () => {
          throw new Error("telemetry initialization failed");
        },
      },
    );
    try {
      expect(logs.join("\n")).toContain("Ratel runtime telemetry disabled");
      expect(logs.join("\n")).toContain("telemetry initialization failed");
      expect(daemonProcessEnv).not.toHaveProperty("RATEL_API_KEY");
      expect([...fs.files.values()].join("\n")).not.toContain("cloud-test-secret");
    } finally {
      await result.shutdown?.();
    }
  });

  it("keeps Cloud telemetry dark unless its feature flag is explicitly enabled", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const cloudFetch = vi.fn();
    const configureRatelTelemetry = vi.fn();
    const daemonProcessEnv = {
      RATEL_CLOUD_OTLP_TRACES_ENDPOINT: "https://cloud.example.test/otlp/v1/traces",
      RATEL_API_KEY: "cloud-test-secret",
    };
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      { readConfig: async () => ({ mcpServers: {} }), processEnv: daemonProcessEnv },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudOtlpFetch: cloudFetch,
        configureRatelTelemetry,
      },
    );
    try {
      const daemonUrl = daemonUrlFromLogs(logs);
      const uiUrl = await mintUiSession(daemonUrl, "daemon-test-token");
      const token = new URL(uiUrl).searchParams.get("t") ?? "";
      const status = await fetch(new URL("/api/cloud-traces", daemonUrl), {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(await status.json()).toMatchObject({ featureEnabled: false, configured: false });
      const relay = await fetch(new URL("/otlp/v1/traces", daemonUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(relay.status).toBe(404);
      expect(configureRatelTelemetry).not.toHaveBeenCalled();
      expect(cloudFetch).not.toHaveBeenCalled();
      expect(daemonProcessEnv).not.toHaveProperty("RATEL_API_KEY");
    } finally {
      await result.shutdown?.();
    }
  });

  it("activates and persists Cloud trace settings from the running daemon UI", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const save = vi.fn(async () => {});
    const configureRatelTelemetry = vi.fn(async () => ({ shutdown: async () => {} }));
    const cloudFetch = vi.fn(async () => new Response(Buffer.from([0x00]), { status: 200 }));
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudOtlpFetch: cloudFetch,
        configureRatelTelemetry,
        cloudSettingsStore: { load: async () => undefined, save },
      },
    );
    const daemonUrl = daemonUrlFromLogs(logs);

    try {
      const unavailable = await fetch(new URL("/otlp/v1/traces", daemonUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(unavailable.status).toBe(503);
      expect(configureRatelTelemetry).not.toHaveBeenCalled();

      const uiUrl = await mintUiSession(daemonUrl, "daemon-test-token");
      const token = new URL(uiUrl).searchParams.get("t") ?? "";
      const saved = await fetch(new URL("/api/cloud-traces", daemonUrl), {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "https://cloud.example.test/api/v1/traces",
          apiKey: "saved-cloud-secret",
        }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({
        featureEnabled: true,
        configured: true,
        endpoint: "https://cloud.example.test/api/v1/traces",
      });
      expect(save).toHaveBeenCalledWith({
        tracesEndpoint: "https://cloud.example.test/api/v1/traces",
        default: "default",
        profiles: { default: { apiKey: "saved-cloud-secret" } },
      });
      expect(configureRatelTelemetry).toHaveBeenCalledWith({
        endpoint: new URL("/otlp/v1/traces", daemonUrl).toString(),
        serviceName: "ratel-local",
      });

      const forwarded = await fetch(new URL("/otlp/v1/traces", daemonUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(forwarded.status).toBe(200);
      expect(cloudFetch).toHaveBeenCalledOnce();
    } finally {
      await result.shutdown?.();
    }
  });

  it("loads persisted Cloud trace settings when a daemon starts", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const configureRatelTelemetry = vi.fn(async () => ({ shutdown: async () => {} }));
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        configureRatelTelemetry,
        cloudSettingsStore: {
          load: async () => ({
            tracesEndpoint: "https://cloud.example.test/api/v1/traces",
            default: "personal",
            profiles: { personal: { apiKey: "persisted-cloud-secret" } },
          }),
          save: async () => {},
        },
      },
    );

    try {
      expect(configureRatelTelemetry).toHaveBeenCalledWith({
        endpoint: new URL("/otlp/v1/traces", daemonUrlFromLogs(logs)).toString(),
        serviceName: "ratel-local",
      });
    } finally {
      await result.shutdown?.();
    }
  });

  it("reads the Cloud credential store with Cloud telemetry disabled", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const configureRatelTelemetry = vi.fn();
    const load = vi.fn(async () => ({
      tracesEndpoint: "https://cloud.example.test/api/v1/traces",
      default: "personal",
      profiles: { personal: { apiKey: "persisted-cloud-secret" } },
    }));
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      { readConfig: async () => ({ mcpServers: {} }), processEnv: {} },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        configureRatelTelemetry,
        cloudSettingsStore: { load, save: async () => {} },
      },
    );

    try {
      expect(load).toHaveBeenCalled();
      const relay = await fetch(new URL("/otlp/v1/traces", daemonUrlFromLogs(logs)), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(relay.status).toBe(404);
      expect(configureRatelTelemetry).not.toHaveBeenCalled();
    } finally {
      await result.shutdown?.();
    }
  });

  it("selects a stored profile by name through RATEL_PROFILE", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const cloudOtlpFetch = vi.fn(async () => new Response(null, { status: 202 }));
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1", RATEL_PROFILE: "acme" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudOtlpFetch,
        configureRatelTelemetry: vi.fn(async () => ({ shutdown: async () => {} })),
        cloudSettingsStore: {
          load: async () => ({
            tracesEndpoint: "https://cloud.example.test/api/v1/traces",
            default: "personal",
            profiles: {
              personal: { apiKey: "wrong-secret" },
              acme: { apiKey: "acme-secret" },
            },
          }),
          save: async () => {},
        },
      },
    );

    try {
      await fetch(new URL("/otlp/v1/traces", daemonUrlFromLogs(logs)), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      const [, init] = cloudOtlpFetch.mock.calls[0] as [URL, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer acme-secret");
    } finally {
      await result.shutdown?.();
    }
  });

  it("keeps the daemon up when RATEL_PROFILE names a profile that is not stored", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1", RATEL_PROFILE: "ghost" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        cloudSettingsStore: {
          load: async () => ({
            tracesEndpoint: "https://cloud.example.test/api/v1/traces",
            default: "personal",
            profiles: { personal: { apiKey: "persisted-cloud-secret" } },
          }),
          save: async () => {},
        },
      },
    );

    try {
      expect(logs.join("\n")).toContain('Cloud profile "ghost" (RATEL_PROFILE environment)');
      // Unresolved profile: 503, never the default key.
      const relay = await fetch(new URL("/otlp/v1/traces", daemonUrlFromLogs(logs)), {
        method: "POST",
        headers: { "Content-Type": "application/x-protobuf" },
        body: Buffer.from([0x0a, 0x00]),
      });
      expect(relay.status).toBe(503);
    } finally {
      await result.shutdown?.();
    }
  });

  it("ignores malformed persisted Cloud settings without taking down the daemon", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const configureRatelTelemetry = vi.fn();
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {} }),
        processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        configureRatelTelemetry,
        cloudSettingsStore: {
          load: async () => {
            throw new Error("settings are malformed");
          },
          save: async () => {},
        },
      },
    );

    try {
      expect(logs.join("\n")).toContain("ignored invalid Cloud settings");
      expect(logs.join("\n")).toContain("settings are malformed");
      expect(configureRatelTelemetry).not.toHaveBeenCalled();
    } finally {
      await result.shutdown?.();
    }
  });

  it("exposes retrieval build health only when the experimental health flag is enabled", async () => {
    const fs = new MemFs();
    const logs: string[] = [];
    const configureRatelTelemetry = vi.fn();
    const result = await runDaemon(
      daemonArgs(),
      makeCtx(fs),
      {
        readConfig: async () => ({ mcpServers: {}, retrieval: { method: "bm25" } }),
        processEnv: { RATEL_EXPERIMENTAL_RETRIEVAL_HEALTH: "1" },
      },
      (message) => logs.push(message),
      {
        open: () => {},
        ensureToken: async () => "daemon-test-token",
        configureRatelTelemetry,
      },
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
      expect(configureRatelTelemetry).not.toHaveBeenCalled();
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
            service: DAEMON_SERVICE_ID,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
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
      service: string;
      protocolVersion: number;
      port: number;
      mcpUrl: string;
      upstreamCount: number;
      activeClientCount: number;
      retrievalHealth?: unknown;
    };
    expect(status.service).toBe(DAEMON_SERVICE_ID);
    expect(status.protocolVersion).toBe(DAEMON_PROTOCOL_VERSION);
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

  it("preserves the install-time PATH separately from npm's macOS daemon PATH", () => {
    const plist = createLaunchAgentPlist({
      executablePath: "/opt/node/bin/node",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      pathEnv: "/opt/node/bin:/usr/bin:/bin",
      featureFlags: { cloudTelemetry: true },
    });

    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain("<string>/opt/node/bin:/usr/bin:/bin</string>");
    expect(plist).toContain(`<key>${DAEMON_INSTALL_PATH_ENV}</key>`);
    expect(plist).toContain(`<key>${CLOUD_TELEMETRY_FEATURE_ENV}</key>`);
  });

  it("installs the macOS daemon LaunchAgent and probes the stable port", async () => {
    const fs = new MemFs();
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const progress: string[] = [];
    const ctx = makeCtx(fs);
    ctx.prompts.spinner = () => ({
      start: (message) => progress.push(`start:${message}`),
      message() {},
      stop: (message) => progress.push(`stop:${message}`),
    });
    await runDaemon(
      daemonArgs({ verb: "install", flags: { telemetry: "off", open: false } }),
      ctx,
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
        probe: offlineThenHealthyProbe(),
      },
    );

    const paths = daemonPaths(HOME);
    expect(fs.files.get(paths.plist)).toContain("<string>/opt/bin/ratel-local</string>");
    expect(commands).toEqual([
      { command: "launchctl", args: ["bootstrap", "gui/501", paths.plist] },
      { command: "launchctl", args: ["kickstart", "-k", "gui/501/ai.ratel.local.daemon"] },
    ]);
    expect(progress).toEqual(["start:Setting up Ratel Local…", "stop:Ratel Local is ready"]);
    expect(logs).toEqual([]);
  });

  it("keeps restart visibly active with friendly lifecycle copy", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    const original = createLaunchAgentPlist({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });
    fs.files.set(paths.plist, original);
    const progress: string[] = [];
    const logs: string[] = [];
    const ctx = makeCtx(fs);
    ctx.prompts.spinner = () => ({
      start: (message) => progress.push(`start:${message}`),
      message: (message) => progress.push(`message:${message}`),
      stop: (message) => progress.push(`stop:${message}`),
    });

    await runDaemon(
      daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
      ctx,
      { processEnv: {} },
      (message) => logs.push(message),
      {
        platform: "darwin",
        getUid: () => 501,
        commandRunner: async () => ({ stdout: "", stderr: "" }),
        probe: offlineThenHealthyProbe(),
      },
    );

    expect(progress).toEqual([
      "start:Restarting Ratel Local…",
      "message:Starting Ratel Local again…",
      "stop:Ratel Local is ready",
    ]);
    expect(logs).toEqual([]);
    expect(fs.files.get(paths.plist)).toBe(original);
  });

  for (const platform of ["darwin", "linux"] as const) {
    it(`enables Cloud telemetry on ${platform} restart when the flag is explicitly set`, async () => {
      const fs = new MemFs();
      const paths = daemonPaths(HOME);
      const pathEnv = "/opt/node/bin:/usr/bin:/bin";
      const servicePath = platform === "linux" ? paths.systemdService : paths.plist;
      const input = {
        executablePath: "/opt/bin/ratel-local",
        homeDir: HOME,
        port: DEFAULT_DAEMON_PORT,
        pathEnv,
        featureFlags: { cloudTelemetry: false },
      };
      fs.files.set(
        servicePath,
        platform === "linux" ? createSystemdUserService(input) : createLaunchAgentPlist(input),
      );
      const commands: Array<{ command: string; args: string[] }> = [];

      await runDaemon(
        daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
        makeCtx(fs),
        { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
        () => {},
        {
          platform,
          getUid: () => 501,
          commandRunner: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          probe: offlineThenHealthyProbe(),
          lifecycleProgress: false,
        },
      );

      const next = fs.files.get(servicePath) ?? "";
      expect(next).toContain(CLOUD_TELEMETRY_FEATURE_ENV);
      expect(next).toContain(pathEnv);
      if (platform === "linux") {
        expect(commands).toEqual([
          { command: "systemctl", args: ["--user", "daemon-reload"] },
          { command: "systemctl", args: ["--user", "stop", SYSTEMD_SERVICE] },
          { command: "systemctl", args: ["--user", "start", SYSTEMD_SERVICE] },
        ]);
      } else {
        expect(commands).toEqual([
          { command: "launchctl", args: ["bootout", "gui/501", paths.plist] },
          { command: "launchctl", args: ["bootstrap", "gui/501", paths.plist] },
          { command: "launchctl", args: ["kickstart", "-k", "gui/501/ai.ratel.local.daemon"] },
        ]);
      }
    });

    it(`preserves Cloud telemetry on ${platform} restart when the flag env is absent`, async () => {
      const fs = new MemFs();
      const paths = daemonPaths(HOME);
      const pathEnv = "/opt/node/bin:/usr/bin:/bin";
      const servicePath = platform === "linux" ? paths.systemdService : paths.plist;
      const input = {
        executablePath: "/opt/bin/ratel-local",
        homeDir: HOME,
        port: DEFAULT_DAEMON_PORT,
        pathEnv,
        featureFlags: { cloudTelemetry: true },
      };
      const original =
        platform === "linux" ? createSystemdUserService(input) : createLaunchAgentPlist(input);
      fs.files.set(servicePath, original);
      const commands: Array<{ command: string; args: string[] }> = [];

      await runDaemon(
        daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
        makeCtx(fs),
        { processEnv: {} },
        () => {},
        {
          platform,
          getUid: () => 501,
          commandRunner: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          probe: offlineThenHealthyProbe(),
          lifecycleProgress: false,
        },
      );

      expect(fs.files.get(servicePath)).toBe(original);
      expect(commands.some((entry) => entry.args.includes("daemon-reload"))).toBe(false);
      if (platform === "linux") {
        expect(commands).toEqual([
          { command: "systemctl", args: ["--user", "stop", SYSTEMD_SERVICE] },
          { command: "systemctl", args: ["--user", "start", SYSTEMD_SERVICE] },
        ]);
      }
    });

    it(`disables Cloud telemetry on ${platform} restart when the flag is explicitly 0`, async () => {
      const fs = new MemFs();
      const paths = daemonPaths(HOME);
      const pathEnv = "/opt/node/bin:/usr/bin:/bin";
      const servicePath = platform === "linux" ? paths.systemdService : paths.plist;
      const input = {
        executablePath: "/opt/bin/ratel-local",
        homeDir: HOME,
        port: DEFAULT_DAEMON_PORT,
        pathEnv,
        featureFlags: { cloudTelemetry: true },
      };
      fs.files.set(
        servicePath,
        platform === "linux" ? createSystemdUserService(input) : createLaunchAgentPlist(input),
      );

      await runDaemon(
        daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
        makeCtx(fs),
        { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "0" } },
        () => {},
        {
          platform,
          getUid: () => 501,
          commandRunner: async () => ({ stdout: "", stderr: "" }),
          probe: offlineThenHealthyProbe(),
          lifecycleProgress: false,
        },
      );

      const next = fs.files.get(servicePath) ?? "";
      expect(next).not.toContain(CLOUD_TELEMETRY_FEATURE_ENV);
      expect(next).toContain(pathEnv);
    });
  }

  it("skips the rewrite when the explicit flag already matches the service", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    const original = createSystemdUserService({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      featureFlags: { cloudTelemetry: true },
    });
    fs.files.set(paths.systemdService, original);
    const commands: Array<{ command: string; args: string[] }> = [];

    await runDaemon(
      daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
      () => {},
      {
        platform: "linux",
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: offlineThenHealthyProbe(),
        lifecycleProgress: false,
      },
    );

    expect(fs.files.get(paths.systemdService)).toBe(original);
    expect(commands.some((entry) => entry.args.includes("daemon-reload"))).toBe(false);
  });

  it("keeps Linux restart visibly active without rewriting the service", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    const original = createSystemdUserService({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
    });
    fs.files.set(paths.systemdService, original);
    const progress: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];
    const ctx = makeCtx(fs);
    ctx.prompts.spinner = () => ({
      start: (message) => progress.push(`start:${message}`),
      message: (message) => progress.push(`message:${message}`),
      stop: (message) => progress.push(`stop:${message}`),
    });

    await runDaemon(
      daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
      ctx,
      { processEnv: {} },
      () => {},
      {
        platform: "linux",
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: offlineThenHealthyProbe(),
      },
    );

    expect(progress).toEqual([
      "start:Restarting Ratel Local…",
      "message:Starting Ratel Local again…",
      "stop:Ratel Local is ready",
    ]);
    expect(fs.files.get(paths.systemdService)).toBe(original);
    expect(commands).toEqual([
      { command: "systemctl", args: ["--user", "stop", SYSTEMD_SERVICE] },
      { command: "systemctl", args: ["--user", "start", SYSTEMD_SERVICE] },
    ]);
  });

  it("does not create a service when restarting with an explicit flag while uninstalled", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);

    await expect(
      runDaemon(
        daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
        makeCtx(fs),
        { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
        () => {},
        {
          platform: "darwin",
          getUid: () => 501,
          commandRunner: async () => ({ stdout: "", stderr: "" }),
          lifecycleProgress: false,
        },
      ),
    ).rejects.toThrow(/not installed/);

    expect(fs.files.has(paths.plist)).toBe(false);
    expect(fs.files.has(paths.systemdService)).toBe(false);
  });

  const installedPlist = () =>
    createLaunchAgentPlist({
      executablePath: "/opt/bin/ratel-local",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      featureFlags: { cloudTelemetry: false },
    });

  const restartWithProbe = (
    fs: MemFs,
    probe: ReturnType<typeof restartStatusProbe>,
    logs: string[],
  ) =>
    runDaemon(
      daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
      (message) => logs.push(message),
      {
        platform: "darwin",
        getUid: () => 501,
        commandRunner: async () => ({ stdout: "", stderr: "" }),
        probe,
        lifecycleProgress: false,
      },
    );

  it("fails when the stopped daemon never releases its port", async () => {
    // The silent-success bug this guards against: a daemon that keeps answering
    // still holds the pre-rewrite service definition.
    await expect(
      waitForDaemonStopped(DEFAULT_DAEMON_PORT, async () => ({ ok: true }), 300),
    ).rejects.toThrow(/did not stop; restart cannot apply service changes/);
  });

  it("notes, but does not fail, a restart whose daemon stops answering", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, installedPlist());
    const logs: string[] = [];
    let calls = 0;

    await restartWithProbe(
      fs,
      async () => {
        calls += 1;
        // Down for the stop check, up for waitForDaemon, gone again by verification.
        return calls === 2 ? { ok: true } : { ok: false, error: "connection refused" };
      },
      logs,
    );

    expect(logs.some((message) => message.includes("the daemon did not answer"))).toBe(true);
  });

  it("accepts a restart whose daemon reports the requested Cloud telemetry state", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, installedPlist());
    const logs: string[] = [];

    await restartWithProbe(fs, restartStatusProbe(true), logs);

    expect(logs.some((message) => message.includes("could not confirm"))).toBe(false);
  });

  it("fails a restart whose daemon still reports the previous Cloud telemetry state", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, installedPlist());

    await expect(restartWithProbe(fs, restartStatusProbe(false), [])).rejects.toThrow(
      /previous service definition may still be loaded/,
    );
  });

  it("notes, but does not fail, a restart whose daemon cannot report the flag", async () => {
    const fs = new MemFs();
    fs.files.set(daemonPaths(HOME).plist, installedPlist());
    const logs: string[] = [];

    await restartWithProbe(fs, restartStatusProbe(undefined), logs);

    expect(
      logs.some((message) => message.includes("could not confirm the requested feature flags")),
    ).toBe(true);
  });

  for (const platform of ["darwin", "linux"] as const) {
    it(`waits for the old daemon to release the port before restarting on ${platform}`, async () => {
      const fs = new MemFs();
      const paths = daemonPaths(HOME);
      const servicePath = platform === "linux" ? paths.systemdService : paths.plist;
      const input = {
        executablePath: "/opt/bin/ratel-local",
        homeDir: HOME,
        port: DEFAULT_DAEMON_PORT,
        featureFlags: { cloudTelemetry: false },
      };
      fs.files.set(
        servicePath,
        platform === "linux" ? createSystemdUserService(input) : createLaunchAgentPlist(input),
      );
      const commands: Array<{ command: string; args: string[] }> = [];
      let probes = 0;

      await runDaemon(
        daemonArgs({ verb: "restart", flags: { telemetry: "off", open: false } }),
        makeCtx(fs),
        { processEnv: { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } },
        () => {},
        {
          platform,
          getUid: () => 501,
          commandRunner: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          // The stopped daemon keeps answering for two probes before it releases
          // the port; the restarted one answers afterwards.
          probe: async (port: number) => {
            probes += 1;
            if (probes <= 2) return { ok: true };
            if (probes === 3) return { ok: false, error: "connection refused" };
            return { ok: port === DEFAULT_DAEMON_PORT };
          },
          lifecycleProgress: false,
        },
      );

      // The rewritten service must actually be loaded: an early "already
      // running" return would skip the bootstrap/start below.
      expect(probes).toBeGreaterThan(3);
      expect(fs.files.get(servicePath) ?? "").toContain(CLOUD_TELEMETRY_FEATURE_ENV);
      if (platform === "linux") {
        expect(commands).toEqual([
          { command: "systemctl", args: ["--user", "daemon-reload"] },
          { command: "systemctl", args: ["--user", "stop", SYSTEMD_SERVICE] },
          { command: "systemctl", args: ["--user", "start", SYSTEMD_SERVICE] },
        ]);
      } else {
        expect(commands).toEqual([
          { command: "launchctl", args: ["bootout", "gui/501", paths.plist] },
          { command: "launchctl", args: ["bootstrap", "gui/501", paths.plist] },
          { command: "launchctl", args: ["kickstart", "-k", "gui/501/ai.ratel.local.daemon"] },
        ]);
      }
    });
  }

  it("ends the lifecycle state clearly when the daemon cannot start", async () => {
    const fs = new MemFs();
    const progress: string[] = [];
    const ctx = makeCtx(fs);
    ctx.prompts.spinner = () => ({
      start: (message) => progress.push(`start:${message}`),
      message() {},
      stop: (message) => progress.push(`stop:${message}`),
    });

    await expect(
      runDaemon(daemonArgs({ verb: "start" }), ctx, {}, () => {}, { platform: "darwin" }),
    ).rejects.toThrow(/not installed/);

    expect(progress).toEqual(["start:Starting Ratel Local…", "stop:Ratel Local couldn't start"]);
  });

  it("does not kickstart an already-running macOS daemon", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    fs.files.set(paths.plist, "<plist />");
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];

    await runDaemon(
      daemonArgs({ verb: "start", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      {},
      (message) => logs.push(message),
      {
        platform: "darwin",
        getUid: () => 501,
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: async () => ({ ok: true }),
        lifecycleProgress: false,
      },
    );

    expect(commands).toEqual([]);
    expect(logs).toEqual(["[ratel] daemon already running at http://127.0.0.1:5731"]);
  });

  it("clears stale daemon state when uninstalling the macOS service", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    fs.files.set(paths.plist, "<plist />");
    fs.files.set(paths.state, JSON.stringify({ pid: 123, version: "0.8.0-rc.0" }));

    await runDaemon(daemonArgs({ verb: "uninstall" }), makeCtx(fs), {}, () => {}, {
      platform: "darwin",
      getUid: () => 501,
      commandRunner: async () => ({ stdout: "", stderr: "" }),
    });

    expect(fs.files.has(paths.plist)).toBe(false);
    expect(fs.files.has(paths.state)).toBe(false);
  });

  it("rejects ephemeral ports for persistent login services", async () => {
    const fs = new MemFs();

    await expect(
      runDaemon(daemonArgs({ verb: "install", flags: { port: "0" } }), makeCtx(fs), {}, () => {}, {
        platform: "darwin",
      }),
    ).rejects.toThrow(/stable port/);
  });

  it("fails installation before service writes when another HTTP service owns the port", async () => {
    const foreign = createHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve, reject) => {
      foreign.once("error", reject);
      foreign.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (foreign.address() as AddressInfo).port;
    const fs = new MemFs();

    try {
      await expect(
        runDaemon(
          daemonArgs({ verb: "install", flags: { port: String(port) } }),
          makeCtx(fs),
          {},
          () => {},
          {
            platform: "darwin",
            executablePath: "/opt/bin/ratel-local",
            getUid: () => 501,
          },
        ),
      ).rejects.toThrow(/occupied.*not a compatible Ratel daemon/);
      expect(fs.files.has(daemonPaths(HOME).plist)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreign.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

  it("preserves the install-time PATH separately from npm's Linux daemon PATH", () => {
    const service = createSystemdUserService({
      executablePath: "/opt/node/bin/node",
      homeDir: HOME,
      port: DEFAULT_DAEMON_PORT,
      pathEnv: "/opt/node/bin:/usr/bin:/bin",
      featureFlags: { cloudTelemetry: true },
    });

    expect(service).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin");
    expect(service).toContain(`Environment=${DAEMON_INSTALL_PATH_ENV}=/opt/node/bin:/usr/bin:/bin`);
    expect(service).toContain(`Environment=${CLOUD_TELEMETRY_FEATURE_ENV}=1`);
  });

  it("installs the Linux user systemd service and probes the stable port", async () => {
    const fs = new MemFs();
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const progress: string[] = [];
    const ctx = makeCtx(fs);
    ctx.prompts.spinner = () => ({
      start: (message) => progress.push(`start:${message}`),
      message() {},
      stop: (message) => progress.push(`stop:${message}`),
    });
    await runDaemon(
      daemonArgs({ verb: "install", flags: { telemetry: "off", open: false } }),
      ctx,
      {},
      (message) => logs.push(message),
      {
        platform: "linux",
        executablePath: "/opt/bin/ratel-local",
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: offlineThenHealthyProbe(),
      },
    );

    const paths = daemonPaths(HOME);
    expect(fs.files.get(paths.systemdService)).toContain("ExecStart=/opt/bin/ratel-local");
    expect(commands).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", SYSTEMD_SERVICE] },
    ]);
    expect(progress).toEqual(["start:Setting up Ratel Local…", "stop:Ratel Local is ready"]);
    expect(logs).toEqual([]);
  });

  it("clears stale daemon state when uninstalling the Linux service", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    fs.files.set(paths.systemdService, "[Service]");
    fs.files.set(paths.state, JSON.stringify({ pid: 123, version: "0.8.0-rc.0" }));

    await runDaemon(daemonArgs({ verb: "uninstall" }), makeCtx(fs), {}, () => {}, {
      platform: "linux",
      commandRunner: async () => ({ stdout: "", stderr: "" }),
    });

    expect(fs.files.has(paths.systemdService)).toBe(false);
    expect(fs.files.has(paths.state)).toBe(false);
  });

  it("does not start an already-running Linux daemon again", async () => {
    const fs = new MemFs();
    const paths = daemonPaths(HOME);
    fs.files.set(paths.systemdService, "[Service]");
    const commands: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];

    await runDaemon(
      daemonArgs({ verb: "start", flags: { telemetry: "off", open: false } }),
      makeCtx(fs),
      {},
      (message) => logs.push(message),
      {
        platform: "linux",
        commandRunner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        probe: async () => ({ ok: true }),
        lifecycleProgress: false,
      },
    );

    expect(commands).toEqual([]);
    expect(logs).toEqual(["[ratel] daemon already running at http://127.0.0.1:5731"]);
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
            service: DAEMON_SERVICE_ID,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
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

function restartStatusProbe(cloudTelemetry?: boolean) {
  let calls = 0;
  return async (port: number) => {
    calls += 1;
    // Stopped for the first probe, then the restarted daemon answers.
    if (calls === 1) return { ok: false, error: "connection refused" };
    return {
      ok: true,
      status: {
        service: DAEMON_SERVICE_ID,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        pid: 321,
        port,
        uiUrl: `http://127.0.0.1:${port}`,
        mcpUrl: `http://127.0.0.1:${port}/mcp`,
        startedAt: "2026-08-24T08:00:00.000Z",
        version: "0.8.2",
        configMode: "auto" as const,
        uptimeSeconds: 1,
        upstreamCount: 0,
        activeClientCount: 0,
        activeGatewayCount: 0,
        activeUserGatewayCount: 0,
        activeProjectGatewayCount: 0,
        ...(cloudTelemetry === undefined ? {} : { cloudTelemetry }),
      },
    };
  };
}

function offlineThenHealthyProbe() {
  let calls = 0;
  return async (port: number) => {
    calls += 1;
    return calls === 1
      ? { ok: false, error: "connection refused" }
      : { ok: port === DEFAULT_DAEMON_PORT };
  };
}

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
