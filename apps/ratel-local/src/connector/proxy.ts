import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type ConnectorDaemonState = "running" | "stopped" | "not-installed" | "unavailable";

export interface ConnectorDaemonStatus {
  state: ConnectorDaemonState;
  message?: string;
}

export interface ConnectorProxyOptions {
  serverTransport: Transport;
  connectBackend: () => Promise<Client>;
  daemonStatus: () => Promise<ConnectorDaemonStatus>;
  startDaemon: () => Promise<void>;
  serverVersion: string;
  log?: (message: string) => void;
  connectTimeoutMs?: number;
  initialConnectionGraceMs?: number;
}

export interface ConnectorProxyHandle {
  shutdown(): Promise<void>;
}

const BOOTSTRAP_TOOLS = [
  {
    name: "ratel_daemon_status",
    description: "Check whether the local Ratel daemon is installed and running.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "ratel_daemon_start",
    description: "Start an already-installed Ratel daemon and attach this MCP connection.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "ratel_daemon_setup",
    description: "Return the command needed to install the persistent local Ratel daemon.",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

export async function runConnectorProxy(
  options: ConnectorProxyOptions,
): Promise<ConnectorProxyHandle> {
  const log = options.log ?? (() => {});
  let backend: Client | null = null;
  let attaching: Promise<Client> | null = null;
  let closed = false;

  const server = new Server(
    { name: "ratel-local-connector", version: options.serverVersion },
    {
      capabilities: { tools: { listChanged: true } },
      instructions:
        "This connector routes Ratel tools through the persistent local daemon. If only daemon " +
        "bootstrap tools are available, explain the daemon state and offer the start or setup action.",
    },
  );

  const attach = async (): Promise<Client> => {
    if (backend) return backend;
    if (attaching) return attaching;
    attaching = connectWithTimeout(options.connectBackend, options.connectTimeoutMs ?? 8_000)
      .then((client) => {
        if (closed) {
          void client.close();
          throw new Error("connector is closed");
        }
        backend = client;
        client.onclose = () => {
          if (backend !== client) return;
          backend = null;
          if (!closed) void server.sendToolListChanged().catch(() => undefined);
        };
        client.onerror = (error) => {
          log(`[ratel] daemon connection error: ${error.message}`);
        };
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await server.sendToolListChanged();
        });
        return client;
      })
      .finally(() => {
        attaching = null;
      });
    return attaching;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!backend) return { tools: BOOTSTRAP_TOOLS };
    return backend.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (backend) return backend.callTool(request.params);

    if (request.params.name === "ratel_daemon_status") {
      return jsonResult(await options.daemonStatus());
    }
    if (request.params.name === "ratel_daemon_setup") {
      return jsonResult({
        state: "setup-required",
        command: "ratel-local daemon install",
        message:
          "Install the persistent daemon from a terminal, then call ratel_daemon_start or reconnect.",
      });
    }
    if (request.params.name === "ratel_daemon_start") {
      try {
        await options.startDaemon();
        await attach();
        await server.sendToolListChanged();
        return jsonResult({ state: "running", message: "Ratel daemon started and connected." });
      } catch (err) {
        return jsonResult(
          {
            state: "start-failed",
            error: (err as Error).message,
            setupCommand: "ratel-local daemon install",
          },
          true,
        );
      }
    }
    throw new Error(`unknown connector tool: ${request.params.name}`);
  });

  server.onclose = () => {
    if (closed) return;
    closed = true;
    const current = backend;
    backend = null;
    void current?.close();
  };

  await server.connect(options.serverTransport);
  const initialAttach = attach();
  void initialAttach
    .then(async () => {
      await server.sendToolListChanged().catch(() => undefined);
    })
    .catch((err) => {
      log(
        `[ratel] daemon unavailable; connector entered bootstrap mode: ${(err as Error).message}`,
      );
    });
  await Promise.race([
    initialAttach.catch(() => undefined),
    delay(options.initialConnectionGraceMs ?? 25),
  ]);

  return {
    shutdown: async () => {
      if (closed) return;
      closed = true;
      const current = backend;
      backend = null;
      await server.close();
      await current?.close();
    },
  };
}

async function connectWithTimeout(
  connect: () => Promise<Client>,
  timeoutMs: number,
): Promise<Client> {
  const pending = connect();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`daemon connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (err) {
    if (timedOut) void pending.then((client) => client.close()).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
    ...(typeof value === "object" && value !== null
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}
