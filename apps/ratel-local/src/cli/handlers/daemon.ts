import { InMemoryMcpClientRegistry } from "../../daemon/client-registry.js";
import { createMcpHttpRoute } from "../../daemon/mcp-http.js";
import { openBrowser } from "../../ui/open-browser.js";
import { newSessionToken } from "../../ui/security.js";
import { startUiServer } from "../../ui/server.js";
import type { ParsedArgs } from "../args.js";
import { buildConfiguredGateway, type ServeOptions } from "./serve.js";
import type { HandlerCtx } from "./types.js";

export interface RunDaemonResult {
  shutdown: () => Promise<void>;
}

export async function runDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: { open?: typeof openBrowser } = {},
): Promise<RunDaemonResult> {
  const port = parsePort(parsed.flags.port);
  const noOpen = parsed.flags.open === false;
  const token = newSessionToken();
  const { config, gateway } = await buildConfiguredGateway(parsed, options, log);
  const registry = new InMemoryMcpClientRegistry();
  const mcp = createMcpHttpRoute({
    gateway,
    registry,
    serverName: options.serverName ?? "ratel",
    serverVersion: options.serverVersion ?? "0.0.0",
    log,
  });
  gateway.setListChangedNotifier(mcp.notifyToolListChanged);

  const ui = await startUiServer({
    ctx,
    token,
    port,
    activeMcpClients: registry,
    publicRoute: async (req, res, path) => {
      if (path !== "/mcp") return false;
      await mcp.handleRequest(req, res);
      return true;
    },
  });

  const upstreamCount = Object.keys(config.mcpServers).length;
  log(`[ratel] daemon running at ${ui.url}`);
  log(`[ratel] MCP HTTP endpoint: http://127.0.0.1:${ui.port}/mcp`);
  log(`[ratel] ready, ${upstreamCount} upstream server(s) configured`);
  log("[ratel] Press Ctrl-C to stop.");

  if (!noOpen) {
    (opts.open ?? openBrowser)(ui.url);
  }

  return {
    shutdown: async () => {
      await mcp.shutdown();
      await ui.shutdown();
      await gateway.close();
    },
  };
}

function parsePort(raw: unknown): number | undefined {
  if (raw === undefined || raw === true || raw === false) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got "${raw}"`);
  }
  return n;
}
