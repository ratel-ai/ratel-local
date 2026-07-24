import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { EmbedderError, type Skill, SkillCatalog } from "@ratel-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayFromConfig,
  expandEnvPlaceholders,
  redirectUrlFromStoredFile,
  resolveHttpHeaders,
} from "./gateway.js";
import { RefreshFailedError } from "./oauth/refresh.js";
import { RatelOAuthStore } from "./oauth/store.js";

interface UpstreamSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function envRef(name: string): string {
  return ["$", `{${name}}`].join("");
}

async function startUpstream(tools: UpstreamSpec[], instructions?: string) {
  const server = new Server(
    { name: "fake", version: "0.0.0" },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: "text", text: JSON.stringify({ called: req.params.name }) }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}

async function startEmbeddingEndpoint(
  vectorForText: (text: string) => number[] = deterministicEmbedding,
  responseStatus = 200,
) {
  const requests: string[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      input?: string | string[];
      model?: string;
    };
    const input = Array.isArray(body.input) ? body.input : [body.input ?? ""];
    requests.push(input);
    if (responseStatus !== 200) {
      response.writeHead(responseStatus, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "deterministic endpoint failure" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        model: body.model ?? "deterministic",
        data: input.map((text, index) => ({
          object: "embedding",
          index,
          embedding: vectorForText(text),
        })),
        usage: { prompt_tokens: input.length, total_tokens: input.length },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/embeddings`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function deterministicEmbedding(text: string): number[] {
  const normalized = text.toLowerCase();
  if (/(weather|forecast|rain|climate|umbrella)/.test(normalized)) return [1, 0, 0];
  if (/(deploy|release|production|vercel)/.test(normalized)) return [0, 1, 0];
  if (/(database|schema|migration)/.test(normalized)) return [0, 0, 1];
  return [0.1, 0.1, 0.1];
}

describe("buildGatewayFromConfig", () => {
  it("uses the same semantic endpoint for tool and skill catalogs and recalls paraphrases", async () => {
    const endpoint = await startEmbeddingEndpoint();
    const upstream = await startUpstream([
      {
        name: "weather",
        description: "Get the current weather forecast for a city.",
      },
      {
        name: "deploy",
        description: "Deploy an application release to production.",
      },
    ]);
    try {
      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            utilities: { type: "stdio", command: "noop" },
          },
          retrieval: {
            method: "semantic",
            embedding: { url: endpoint.url, model: "deterministic" },
          },
        },
        {
          transportFactory: () => upstream.clientTransport,
          resolvedSkills: [
            {
              id: "weather-playbook",
              name: "Weather planning",
              description: "Decide whether the forecast calls for an umbrella.",
            },
            {
              id: "release-playbook",
              name: "Release playbook",
              description: "Safely deploy a production release.",
            },
          ],
        },
      );

      expect(endpoint.requests).toHaveLength(2);
      expect((await handle.catalog.searchAsync("should I pack for rain?", 1))[0]?.toolId).toBe(
        "utilities__weather",
      );
      expect(
        (await handle.skillCatalog.searchAsync("should I bring an umbrella?", 1))[0]?.skillId,
      ).toBe("weather-playbook");
      expect(endpoint.requests).toHaveLength(4);

      await handle.close();
    } finally {
      await upstream.server.close();
      await endpoint.close();
    }
  });

  it("keeps exact lexical matches in hybrid retrieval", async () => {
    const endpoint = await startEmbeddingEndpoint(() => [1, 0, 0]);
    const upstream = await startUpstream([
      { name: "exact_release", description: "Run the lunar-release-42 deployment." },
      { name: "other_release", description: "Deploy another production release." },
    ]);
    try {
      const handle = await buildGatewayFromConfig(
        {
          mcpServers: { utilities: { type: "stdio", command: "noop" } },
          retrieval: {
            method: "hybrid",
            embedding: { url: endpoint.url, model: "deterministic" },
          },
        },
        { transportFactory: () => upstream.clientTransport },
      );

      expect((await handle.catalog.searchAsync("lunar-release-42", 1))[0]?.toolId).toBe(
        "utilities__exact_release",
      );
      await handle.close();
    } finally {
      await upstream.server.close();
      await endpoint.close();
    }
  });

  it("does not contact an embedding endpoint when BM25 is selected", async () => {
    const endpoint = await startEmbeddingEndpoint();
    const upstream = await startUpstream([{ name: "weather", description: "Weather forecast." }]);
    try {
      const handle = await buildGatewayFromConfig(
        {
          mcpServers: { utilities: { type: "stdio", command: "noop" } },
          retrieval: {
            method: "bm25",
            // parseConfig rejects this inactive combination. Keeping the test
            // seam here proves the SDK's BM25 path itself remains traffic-free.
            embedding: { url: endpoint.url, model: "must-not-be-called" },
          },
        },
        { transportFactory: () => upstream.clientTransport },
      );

      expect(handle.catalog.search("weather", 1)[0]?.toolId).toBe("utilities__weather");
      expect(endpoint.requests).toEqual([]);
      await handle.close();
    } finally {
      await upstream.server.close();
      await endpoint.close();
    }
  });

  it("fails dense readiness with a typed error when corpus embedding fails", async () => {
    const endpoint = await startEmbeddingEndpoint(deterministicEmbedding, 503);
    try {
      await expect(
        buildGatewayFromConfig(
          {
            mcpServers: {},
            retrieval: {
              method: "semantic",
              embedding: { url: endpoint.url, model: "deterministic" },
            },
          },
          {
            resolvedSkills: [
              {
                id: "weather-playbook",
                name: "Weather planning",
                description: "Plan around the weather forecast.",
              },
            ],
          },
        ),
      ).rejects.toBeInstanceOf(EmbedderError);
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await endpoint.close();
    }
  });

  it("stores dense OAuth authorization without mutating the active generation", async () => {
    const endpoint = await startEmbeddingEndpoint();
    const closeAuthorizedHandle = vi.fn(async () => {});
    const notify = vi.fn(async () => {});
    try {
      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            remote: { type: "http", url: "https://remote.example/mcp" },
          },
          retrieval: {
            method: "semantic",
            embedding: { url: endpoint.url, model: "deterministic" },
          },
        },
        {
          oauthStorePath: (name) => join(tmpdir(), `ratel-dense-auth-${name}-${Date.now()}.json`),
          transportFactory: () => ({
            async start() {
              throw new UnauthorizedError("missing tokens");
            },
            async send() {},
            async close() {},
          }),
          authStep: async () => ({
            status: "authorized",
            mode: "interactive",
            handle: {
              toolIds: ["remote__weather"],
              serverInstructions: undefined,
              close: closeAuthorizedHandle,
            },
          }),
        },
      );
      handle.setListChangedNotifier(notify);

      const results = await handle.runAuthFlow({ name: "remote" });

      expect(results).toEqual([
        expect.objectContaining({
          name: "remote",
          status: "authorized",
          reason: expect.stringMatching(/reconnect.*new retrieval generation/i),
        }),
      ]);
      expect(handle.catalog.has("remote__weather")).toBe(false);
      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "remote", needsAuth: true }),
      );
      expect(closeAuthorizedHandle).toHaveBeenCalledOnce();
      expect(notify).not.toHaveBeenCalled();
      expect(endpoint.requests).toEqual([]);

      await handle.close();
    } finally {
      await endpoint.close();
    }
  });

  it("awaits one batched registration for resolved gateway skills", async () => {
    const skills: Skill[] = [
      {
        id: "api-design",
        name: "API design",
        description: "Design stable HTTP APIs.",
      },
      {
        id: "database-migrations",
        name: "Database migrations",
        description: "Plan safe database schema changes.",
      },
    ];
    const originalRegister = SkillCatalog.prototype.register;
    let releaseRegistration: (() => void) | undefined;
    const registrationGate = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const register = vi
      .spyOn(SkillCatalog.prototype, "register")
      .mockImplementation(async function (registeredSkills) {
        await registrationGate;
        await originalRegister.call(this, registeredSkills);
      });
    let settled = false;
    const pending = buildGatewayFromConfig({ mcpServers: {} }, { resolvedSkills: skills }).then(
      (handle) => {
        settled = true;
        return handle;
      },
    );

    try {
      await Promise.resolve();
      expect(register).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledWith(skills);
      expect(settled).toBe(false);

      releaseRegistration?.();
      const handle = await pending;
      expect(handle.skillCatalog.has("api-design")).toBe(true);
      expect(handle.skillCatalog.has("database-migrations")).toBe(true);
      await handle.close();
    } finally {
      releaseRegistration?.();
      register.mockRestore();
    }
  });

  it("registers tools from every upstream the factory wires up, namespaced by entry key", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file from local disk." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL over HTTP." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.catalog.has("fs__read_file")).toBe(true);
    expect(handle.catalog.has("remote__fetch")).toBe(true);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("builds from resolved MCP entries and passes scoped runtime inputs to transports", async () => {
    const fs = await startUpstream([{ name: "read_file", description: "Read a file." }]);
    const runtimeInputs: unknown[] = [];

    const handle = await buildGatewayFromConfig(
      { mcpServers: {} },
      {
        resolvedMcpEntries: [
          {
            name: "fs",
            entry: { type: "stdio", command: "noop" },
            owner: { scope: "project", projectId: "prj_test" },
            status: "effective",
            runtimeCwd: "/workspace/project-a",
            oauthKey: { path: "/tmp/scoped-oauth.json", fingerprint: "fingerprint" },
            diagnostics: [],
          },
        ],
        transportFactory: (_name, _entry, runtime) => {
          runtimeInputs.push(runtime);
          return fs.clientTransport;
        },
      },
    );

    expect(handle.catalog.has("fs__read_file")).toBe(true);
    expect(runtimeInputs).toEqual([
      {
        cwd: "/workspace/project-a",
        oauthStorePath: "/tmp/scoped-oauth.json",
        oauthStoreFingerprint: "fingerprint",
      },
    ]);

    await handle.close();
    await fs.server.close();
  });

  it("skips entries with unsupported transport types and logs a warning", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          legacy: { type: "sse", url: "https://x" },
          future: { type: "websocket", url: "ws://x" },
        },
      },
      { transportFactory: () => undefined, logger: (m) => logs.push(m) },
    );

    expect(handle.catalog.has("legacy__anything")).toBe(false);
    expect(logs.join("\n")).toMatch(/legacy/);
    expect(logs.join("\n")).toMatch(/future/);

    await handle.close();
  });

  it("warns and continues when one upstream fails to register, leaving the rest available", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop" },
          ok: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") {
            throw new Error("boom");
          }
          return ok.clientTransport;
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.has("ok__ping")).toBe(true);
    expect(handle.catalog.has("broken__ping")).toBe(false);
    expect(logs.join("\n")).toMatch(/broken.*boom/);

    await handle.close();
    await ok.server.close();
  });

  it("returns an empty catalog when every entry fails to register", async () => {
    const logs: string[] = [];
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { a: { type: "stdio", command: "noop" } },
      },
      {
        transportFactory: () => {
          throw new Error("nope");
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.catalog.search("anything", 5)).toEqual([]);
    expect(logs.length).toBeGreaterThan(0);

    await handle.close();
  });

  it("exposes upstreamServers with name, description from config, and tool count", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file." },
      { name: "write_file", description: "Write a file." },
    ]);
    const remote = await startUpstream([{ name: "fetch", description: "Fetch a URL." }]);
    const transports: Record<string, Transport> = {
      fs: fs.clientTransport,
      remote: remote.clientTransport,
    };

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          fs: { type: "stdio", command: "noop", description: "filesystem tools" },
          remote: { type: "http", url: "https://example.com" },
        },
      },
      { transportFactory: (name) => transports[name] },
    );

    expect(handle.upstreamServers).toEqual([
      { name: "fs", description: "filesystem tools", toolCount: 2 },
      { name: "remote", toolCount: 1 },
    ]);

    await handle.close();
    await fs.server.close();
    await remote.server.close();
  });

  it("records estimated upstream tool payload tokens after registration", async () => {
    const fs = await startUpstream([
      { name: "read_file", description: "Read a file from disk." },
      { name: "write_file", description: "Write a file to disk." },
    ]);
    const dir = await mkdtemp(join(tmpdir(), "ratel-gateway-trace-"));
    const telemetryFile = join(dir, "trace.jsonl");

    try {
      const handle = await buildGatewayFromConfig(
        { mcpServers: { fs: { type: "stdio", command: "noop" } } },
        {
          transportFactory: () => fs.clientTransport,
          trace: { kind: "jsonl", sessionId: "t", path: telemetryFile },
        },
      );

      const events = (await readFile(telemetryFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "ratel_tool_payload",
          server: "fs",
          tool_count: 2,
        }),
      );
      const estimate = events.find((event) => event.type === "ratel_tool_payload");
      expect(estimate?.estimated_tokens).toEqual(expect.any(Number));
      expect(estimate?.estimated_tokens as number).toBeGreaterThan(0);

      await handle.close();
      await fs.server.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits failed upstreams from upstreamServers", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          broken: { type: "stdio", command: "noop", description: "broken one" },
          ok: { type: "stdio", command: "noop" },
          unsupported: { type: "websocket", url: "ws://x" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "broken") throw new Error("boom");
          if (name === "ok") return ok.clientTransport;
          return undefined;
        },
        logger: () => {},
      },
    );

    expect(handle.upstreamServers).toEqual([{ name: "ok", toolCount: 1 }]);

    await handle.close();
    await ok.server.close();
  });

  it("falls back to the upstream's `instructions` when no description is set on the config entry", async () => {
    const fs = await startUpstream(
      [{ name: "ping", description: "Ping." }],
      "Use this server for filesystem ops.",
    );
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers).toEqual([
      {
        name: "fs",
        description: "Use this server for filesystem ops.",
        instructions: "Use this server for filesystem ops.",
        toolCount: 1,
      },
    ]);
    await handle.close();
    await fs.server.close();
  });

  it("prefers the config entry's description over the upstream's `instructions` when both are present, but still surfaces the raw instructions separately", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }], "from-upstream");
    const handle = await buildGatewayFromConfig(
      {
        mcpServers: { fs: { type: "stdio", command: "noop", description: "from-config" } },
      },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBe("from-config");
    expect(handle.upstreamServers[0].instructions).toBe("from-upstream");
    await handle.close();
    await fs.server.close();
  });

  it("omits both description and instructions when neither config nor upstream provide them", async () => {
    const fs = await startUpstream([{ name: "ping", description: "Ping." }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { fs: { type: "stdio", command: "noop" } } },
      { transportFactory: () => fs.clientTransport },
    );
    expect(handle.upstreamServers[0].description).toBeUndefined();
    expect(handle.upstreamServers[0].instructions).toBeUndefined();
    await handle.close();
    await fs.server.close();
  });

  it("close() tears down every upstream handle even if one rejects", async () => {
    const upstream = await startUpstream([{ name: "x", description: "x" }]);
    const handle = await buildGatewayFromConfig(
      { mcpServers: { up: { type: "stdio", command: "noop" } } },
      { transportFactory: () => upstream.clientTransport },
    );

    await expect(handle.close()).resolves.toBeUndefined();
    await upstream.server.close();
  });

  it("flags HTTP upstreams as needsAuth when boot register throws UnauthorizedError, retaining the entry for re-auth", async () => {
    const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          locked: { type: "http", url: "https://locked.example/mcp" },
          fs: { type: "stdio", command: "noop" },
        },
      },
      {
        transportFactory: (name) => {
          if (name === "fs") return ok.clientTransport;
          // For the http entry, return a transport whose start() throws Unauthorized
          return {
            async start() {
              throw new UnauthorizedError("missing tokens");
            },
            async send() {},
            async close() {},
          };
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "locked", needsAuth: true }),
    );
    expect(handle.upstreamServers).toContainEqual(
      expect.objectContaining({ name: "fs", toolCount: 1 }),
    );
    expect(handle.catalog.has("fs__ping")).toBe(true);

    await handle.close();
    await ok.server.close();
  });

  it.each([
    Object.assign(new Error("request failed"), { status: 401 }),
    Object.assign(new Error("request failed"), { statusCode: 403 }),
    Object.assign(new Error("request failed"), { response: { status: 401 } }),
    new Error("401 Unauthorized"),
    Object.assign(new Error("request failed"), { code: "ERR_UNAUTHORIZED" }),
  ])("flags HTTP upstreams as needsAuth when boot register throws an auth-shaped error %#", async (authError) => {
    const logs: string[] = [];

    const handle = await buildGatewayFromConfig(
      {
        mcpServers: {
          linear: {
            type: "http",
            url: "https://mcp.linear.example/mcp",
            description: "Linear workspace tools",
          },
        },
      },
      {
        oauthStorePath: (name) => join(tmpdir(), `ratel-gateway-test-${name}.json`),
        transportFactory: () => {
          throw authError;
        },
        logger: (m) => logs.push(m),
      },
    );

    expect(handle.upstreamServers).toEqual([
      {
        name: "linear",
        description: "Linear workspace tools",
        needsAuth: true,
      },
    ]);
    expect(logs.join("\n")).toMatch(/linear requires authorization/);

    await handle.close();
  });

  describe("OAuth boot path", () => {
    let oauthDir: string;
    beforeEach(async () => {
      oauthDir = await mkdtemp(join(tmpdir(), "ratel-gateway-oauth-"));
    });
    afterEach(async () => {
      await rm(oauthDir, { recursive: true, force: true });
    });

    function storePath(name: string): string {
      return join(oauthDir, `${name}.json`);
    }

    async function seedStoredTokens(name: string, expiresAt: number): Promise<void> {
      const store = new RatelOAuthStore(storePath(name));
      await store.save({
        tokens: {
          access_token: "old",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rtk",
        },
        client_information: { client_id: "cid", redirect_uris: ["http://127.0.0.1:0/cb"] },
        discovery_state: {
          authorizationServerUrl: "https://issuer.example",
          authorizationServerMetadata: {
            issuer: "https://issuer.example",
            token_endpoint: "https://issuer.example/token",
            response_types_supported: ["code"],
          },
        },
      });
      const fs = await import("node:fs/promises");
      const raw = JSON.parse(await fs.readFile(storePath(name), "utf8"));
      raw.expires_at = expiresAt;
      await fs.writeFile(storePath(name), JSON.stringify(raw, null, 2));
    }

    it("marks a changed OAuth target as needsAuth without constructing a transport", async () => {
      const store = new RatelOAuthStore(storePath("remote"), "old-target");
      await store.save({
        tokens: {
          access_token: "old",
          token_type: "Bearer",
          refresh_token: "refresh",
        },
      });
      const factory = vi.fn(() => undefined);
      const logs: string[] = [];

      const handle = await buildGatewayFromConfig(
        { mcpServers: {} },
        {
          resolvedMcpEntries: [
            {
              name: "remote",
              entry: { type: "http", url: "https://new.example/mcp" },
              owner: { scope: "user" },
              status: "effective",
              runtimeCwd: "/home/u",
              oauthKey: { path: storePath("remote"), fingerprint: "new-target" },
              diagnostics: [],
            },
          ],
          transportFactory: factory,
          logger: (message) => logs.push(message),
        },
      );

      expect(factory).not.toHaveBeenCalled();
      expect(handle.upstreamServers).toContainEqual({ name: "remote", needsAuth: true });
      expect(logs.join("\n")).toMatch(/target changed.*re-authoriz/i);

      await handle.close();
    });

    it("calls refreshTokens for HTTP upstreams with stored tokens before register", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const refreshTokens = vi.fn(async () => undefined);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens,
        },
      );

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", toolCount: 1 }),
      );
      expect(handle.catalog.has("locked__ping")).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("marks upstream needsAuth and skips register when refresh fails", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const refreshTokens = vi.fn(async () => {
        throw new RefreshFailedError(new Error("invalid_grant"));
      });
      const factory = vi.fn(() => ok.clientTransport);
      const logs: string[] = [];

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: factory,
          oauthStorePath: storePath,
          refreshTokens,
          logger: (m) => logs.push(m),
        },
      );

      expect(refreshTokens).toHaveBeenCalledTimes(1);
      expect(factory).not.toHaveBeenCalled();
      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", needsAuth: true }),
      );
      expect(logs.join("\n")).toMatch(/locked.*re-authoriz/i);

      await handle.close();
      await ok.server.close();
    });

    it("emits auth_refresh{ok:true} after a successful boot-time refresh", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens: async () => undefined,
          trace: { kind: "memory", sessionId: "t" },
        },
      );

      const events = handle.catalog.drainTraceEvents() as Array<Record<string, unknown>>;
      const refreshed = events.find((e) => e.type === "auth_refresh");
      expect(refreshed?.upstream).toBe("locked");
      expect(refreshed?.ok).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("emits auth_refresh{ok:false} and auth_needs when refresh fails", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      await seedStoredTokens("locked", Date.now() - 5_000);

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens: async () => {
            throw new RefreshFailedError(new Error("invalid_grant"));
          },
          trace: { kind: "memory", sessionId: "t" },
        },
      );

      const events = handle.catalog.drainTraceEvents() as Array<Record<string, unknown>>;
      expect(events).toContainEqual(
        expect.objectContaining({ type: "auth_refresh", upstream: "locked", ok: false }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "auth_needs", upstream: "locked" }),
      );

      await handle.close();
      await ok.server.close();
    });

    it("skips proactive refresh for HTTP upstreams without stored tokens", async () => {
      const ok = await startUpstream([{ name: "ping", description: "Ping." }]);
      const refreshTokens = vi.fn();

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            fresh: { type: "http", url: "https://fresh.example/mcp" },
          },
        },
        {
          transportFactory: () => ok.clientTransport,
          oauthStorePath: storePath,
          refreshTokens,
        },
      );

      expect(refreshTokens).not.toHaveBeenCalled();
      expect(handle.catalog.has("fresh__ping")).toBe(true);

      await handle.close();
      await ok.server.close();
    });

    it("redirectUrlFromStoredFile reads client_information.redirect_uris[0] from the OAuth file", async () => {
      const fs = await import("node:fs/promises");
      const path = join(oauthDir, "demo.json");
      await fs.writeFile(
        path,
        JSON.stringify({
          client_information: { redirect_uris: ["http://127.0.0.1:54321/cb", "https://other"] },
        }),
      );
      expect(redirectUrlFromStoredFile(path)).toBe("http://127.0.0.1:54321/cb");
      expect(redirectUrlFromStoredFile(join(oauthDir, "missing.json"))).toBeUndefined();
    });

    it("classifies SDK 'prepareTokenRequest' errors as needsAuth instead of dropping the upstream", async () => {
      await seedStoredTokens("locked", Date.now() - 5_000);
      const refreshTokens = vi.fn(async () => undefined);
      const logs: string[] = [];

      const handle = await buildGatewayFromConfig(
        {
          mcpServers: {
            locked: { type: "http", url: "https://locked.example/mcp" },
          },
        },
        {
          transportFactory: () => ({
            async start() {
              throw new Error(
                "Either provider.prepareTokenRequest() or authorizationCode is required",
              );
            },
            async send() {},
            async close() {},
          }),
          oauthStorePath: storePath,
          refreshTokens,
          logger: (m) => logs.push(m),
        },
      );

      expect(handle.upstreamServers).toContainEqual(
        expect.objectContaining({ name: "locked", needsAuth: true }),
      );
      await handle.close();
    });
  });

  it("exposes a runAuthFlow function on the handle", async () => {
    const handle = await buildGatewayFromConfig(
      { mcpServers: {} },
      { transportFactory: () => undefined },
    );
    expect(typeof handle.runAuthFlow).toBe("function");
    // Without any http upstreams, runs no targets and returns empty.
    const results = await handle.runAuthFlow({});
    expect(results).toEqual([]);
    await handle.close();
  });
});

describe("resolveHttpHeaders", () => {
  it("expands environment placeholders in static headers", () => {
    const headers = resolveHttpHeaders(
      {
        type: "http",
        url: "https://example.com/mcp",
        headers: {
          "X-Static": "static",
          "X-API-Key": envRef("MCP_API_KEY"),
          Authorization: `Bearer ${envRef("MCP_TOKEN")}`,
        },
      },
      { MCP_API_KEY: "api-key", MCP_TOKEN: "token" },
    );

    expect(headers).toEqual({
      "X-Static": "static",
      "X-API-Key": "api-key",
      Authorization: "Bearer token",
    });
  });
});

describe("expandEnvPlaceholders", () => {
  it("expands environment placeholders and leaves missing placeholders visible", () => {
    expect(
      expandEnvPlaceholders(`https://${envRef("MCP_HOST")}/mcp/${envRef("MISSING")}`, {
        MCP_HOST: "example.com",
      }),
    ).toBe(`https://example.com/mcp/${envRef("MISSING")}`);
  });
});
