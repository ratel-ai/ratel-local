import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerHandle } from "@ratel-ai/ratel-local-core";
import { createMcpServer } from "@ratel-ai/ratel-local-core";
import { authorizeDaemonRequest, DaemonAccessError, resolveDaemonRequestScope } from "./access.js";
import {
  type InMemoryMcpClientRegistry,
  pendingRegistrationFromInitialize,
} from "./client-registry.js";
import type { GatewayLease, ScopedGatewayPool } from "./scoped-gateway-pool.js";

interface McpHttpSession {
  handle: McpServerHandle;
  transport: StreamableHTTPServerTransport;
  lease: GatewayLease;
  dispose: () => Promise<void>;
}

export interface McpHttpRoute {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  notifyToolListChanged(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CreateMcpHttpRouteOptions {
  gatewayPool: ScopedGatewayPool;
  daemonToken: string;
  registry: InMemoryMcpClientRegistry;
  serverName: string;
  serverVersion: string;
  log?: (message: string) => void;
}

export function createMcpHttpRoute(opts: CreateMcpHttpRouteOptions): McpHttpRoute {
  const sessions = new Map<string, McpHttpSession>();
  const log = opts.log ?? (() => {});

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      if (method === "POST") {
        await handlePost(req, res);
        return;
      }
      if (method === "GET" || method === "DELETE") {
        await handleSessionRequest(req, res);
        return;
      }
      writeJsonRpcError(res, 405, -32000, "Method not allowed.");
    } catch (err) {
      log(`[ratel] MCP HTTP error: ${(err as Error).message}`);
      if (!res.headersSent) {
        if (err instanceof DaemonAccessError) {
          writeJsonRpcError(res, err.status, -32003, err.message);
        } else {
          writeJsonRpcError(res, 500, -32603, "Internal server error");
        }
      }
    }
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorizeDaemonRequest(req.headers, opts.daemonToken);
    const sessionId = sessionIdFromRequest(req);
    const body = await readJsonBody(req);

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        writeJsonRpcError(res, 404, -32001, "Unknown MCP session ID.");
        return;
      }
      opts.registry.markSeen(sessionId);
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonRpcError(res, 400, -32000, "Bad Request: initialize request required.");
      return;
    }

    const scope = await resolveDaemonRequestScope(req.headers, opts.daemonToken);
    const lease = await opts.gatewayPool.acquire(scope);
    const registration = pendingRegistrationFromInitialize(req, body, {
      scope: scope.kind,
      scopeKey: lease.scopeKey,
      ...(scope.kind === "project" ? { projectRoot: scope.projectRoot } : {}),
    });
    let transport: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSessionId) => {
        const session = pendingSessions.get(transport);
        if (!session) return;
        sessions.set(newSessionId, session);
        pendingSessions.delete(transport);
        opts.registry.register(newSessionId, registration);
        log(`[ratel] MCP client connected: ${registration.name} (${newSessionId})`);
      },
    });

    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      const session = closedSessionId
        ? sessions.get(closedSessionId)
        : pendingSessions.get(transport);
      if (!session) return;
      if (closedSessionId) {
        sessions.delete(closedSessionId);
        opts.registry.close(closedSessionId);
        log(`[ratel] MCP client disconnected: ${closedSessionId}`);
      } else {
        pendingSessions.delete(transport);
      }
      void session.dispose();
    };

    try {
      const handle = await createMcpServer(lease.gateway.catalog, {
        name: opts.serverName,
        version: opts.serverVersion,
        transport,
        upstreamServers: lease.gateway.upstreamServers,
        runAuthFlow: lease.gateway.runAuthFlow,
        skillCatalog: lease.gateway.skillCatalog,
      });
      let disposed = false;
      const unsubscribe = lease.subscribeListChanged(handle.notifyToolListChanged);
      const dispose = async () => {
        if (disposed) return;
        disposed = true;
        unsubscribe();
        await lease.release();
      };
      pendingSessions.set(transport, { handle, transport, lease, dispose });
      await transport.handleRequest(req, res, body);
    } catch (err) {
      await lease.release();
      throw err;
    }
  }

  async function handleSessionRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authorizeDaemonRequest(req.headers, opts.daemonToken);
    const sessionId = sessionIdFromRequest(req);
    if (!sessionId) {
      writePlain(res, 400, "Missing MCP session ID.");
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      writePlain(res, 404, "Unknown MCP session ID.");
      return;
    }
    opts.registry.markSeen(sessionId);
    await session.transport.handleRequest(req, res);
  }

  const pendingSessions = new Map<StreamableHTTPServerTransport, McpHttpSession>();

  return {
    handleRequest,
    notifyToolListChanged: async () => {
      const results = await Promise.allSettled(
        Array.from(sessions.values()).map((session) => session.handle.notifyToolListChanged()),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          log(
            `[ratel] failed to notify MCP HTTP client: ${
              (result.reason as Error)?.message ?? result.reason
            }`,
          );
        }
      }
    },
    shutdown: async () => {
      const allSessions = [...sessions.values(), ...pendingSessions.values()];
      sessions.clear();
      pendingSessions.clear();
      const results = await Promise.allSettled(
        allSessions.map(async (session) => {
          await session.handle.close();
          await session.dispose();
        }),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          log(`[ratel] error closing MCP HTTP session: ${(result.reason as Error).message}`);
        }
      }
    },
  };
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    chunks.push(chunk);
    size += chunk.length;
    if (size > 5_000_000) {
      throw new Error("request body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function writePlain(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(message);
}
