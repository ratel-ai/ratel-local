import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { runConnectorProxy } from "./proxy.js";

async function backend() {
  const server = new Server({ name: "daemon", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "search_capabilities", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: JSON.stringify(request.params.arguments ?? {}) }],
  }));
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "connector", version: "1.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("runConnectorProxy", () => {
  it("forwards daemon tools and call results", async () => {
    const remote = await backend();
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const connector = await runConnectorProxy({
      serverTransport: connectorTransport,
      connectBackend: async () => remote.client,
      daemonStatus: async () => ({ state: "running" }),
      startDaemon: async () => {},
      serverVersion: "1.0.0",
    });
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);

    expect((await host.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
    ]);
    const result = await host.callTool({
      name: "search_capabilities",
      arguments: { query: "docs" },
    });
    expect(result.content).toEqual([{ type: "text", text: '{"query":"docs"}' }]);

    await host.close();
    await connector.shutdown();
    await remote.server.close();
  });

  it("starts in bootstrap mode and attaches after starting the daemon", async () => {
    const remote = await backend();
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const connectBackend = vi
      .fn<() => Promise<Client>>()
      .mockRejectedValueOnce(new Error("daemon offline"))
      .mockResolvedValue(remote.client);
    const startDaemon = vi.fn(async () => {});
    const connector = await runConnectorProxy({
      serverTransport: connectorTransport,
      connectBackend,
      daemonStatus: async () => ({ state: "stopped" }),
      startDaemon,
      serverVersion: "1.0.0",
    });
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);

    expect((await host.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "ratel_daemon_setup",
      "ratel_daemon_start",
      "ratel_daemon_status",
    ]);
    const start = await host.callTool({ name: "ratel_daemon_start", arguments: {} });
    expect(start.isError).not.toBe(true);
    expect(startDaemon).toHaveBeenCalledOnce();
    expect((await host.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_capabilities",
    ]);

    await host.close();
    await connector.shutdown();
    await remote.server.close();
  });

  it("returns setup guidance without attempting installation", async () => {
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const connector = await runConnectorProxy({
      serverTransport: connectorTransport,
      connectBackend: async () => {
        throw new Error("daemon offline");
      },
      daemonStatus: async () => ({ state: "not-installed" }),
      startDaemon: async () => {
        throw new Error("not installed");
      },
      serverVersion: "1.0.0",
    });
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);

    const result = await host.callTool({ name: "ratel_daemon_setup", arguments: {} });
    expect((result.content as Array<{ text: string }>)[0].text).toContain(
      "ratel-local daemon install",
    );

    await host.close();
    await connector.shutdown();
  });

  it("initializes stdio in bootstrap mode while a daemon connection is hung", async () => {
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const connector = await runConnectorProxy({
      serverTransport: connectorTransport,
      connectBackend: () => new Promise<Client>(() => {}),
      daemonStatus: async () => ({ state: "unavailable" }),
      startDaemon: async () => {},
      serverVersion: "1.0.0",
      connectTimeoutMs: 20,
      initialConnectionGraceMs: 1,
    });
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);

    expect((await host.listTools()).tools.map((tool) => tool.name)).toContain(
      "ratel_daemon_status",
    );

    await host.close();
    await connector.shutdown();
  });

  it("returns to bootstrap tools when the daemon disconnects", async () => {
    const remote = await backend();
    const [connectorTransport, hostTransport] = InMemoryTransport.createLinkedPair();
    const connector = await runConnectorProxy({
      serverTransport: connectorTransport,
      connectBackend: async () => remote.client,
      daemonStatus: async () => ({ state: "stopped" }),
      startDaemon: async () => {},
      serverVersion: "1.0.0",
    });
    const host = new Client({ name: "host", version: "1.0.0" });
    await host.connect(hostTransport);
    expect((await host.listTools()).tools[0].name).toBe("search_capabilities");

    await remote.server.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((await host.listTools()).tools.map((tool) => tool.name)).toContain(
      "ratel_daemon_status",
    );
    await host.close();
    await connector.shutdown();
  });
});
