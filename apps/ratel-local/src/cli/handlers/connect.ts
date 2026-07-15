import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { readJson } from "@ratel-ai/ratel-local-core";
import { type ConnectorDaemonStatus, runConnectorProxy } from "../../connector/proxy.js";
import {
  type AgentLinkScope,
  connectorHeaders,
  type DeclaredAgentHost,
  readDaemonToken,
} from "../../daemon/access.js";
import type { ParsedArgs } from "../args.js";
import {
  type DaemonState,
  DEFAULT_DAEMON_PORT,
  daemonPaths,
  inspectDaemonService,
  runDaemon,
} from "./daemon.js";
import { resolveAutoConfig, type ServeOptions } from "./serve.js";
import type { HandlerCtx } from "./types.js";

export interface ConnectBackendInput {
  daemonUrl: URL;
  token: string;
  projectRoot?: string;
  clientVersion: string;
  agentHost?: DeclaredAgentHost;
  linkScope?: AgentLinkScope;
}

export interface ConnectOptions extends ServeOptions {
  cliVersion?: string;
  connectBackend?: (input: ConnectBackendInput) => Promise<Client>;
  daemonStatus?: (daemonUrl: URL, ctx: HandlerCtx) => Promise<ConnectorDaemonStatus>;
  startDaemon?: () => Promise<void>;
  connectorTransport?: Transport;
  readToken?: (homeDir: string) => Promise<string | null>;
}

export async function runConnect(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ConnectOptions,
  log: (message: string) => void,
): Promise<{ shutdown: () => Promise<void> }> {
  const resolution = resolveAutoConfig(parsed, options, () => {});
  const projectRoot = resolution.projectRoot;
  const daemonUrl = await resolveDaemonUrl(parsed, ctx);
  const version = options.cliVersion ?? options.serverVersion ?? "0.0.0";
  const connectBackend = options.connectBackend ?? defaultConnectBackend;
  const agentHost = enumFlag(parsed.flags["agent-host"], "--agent-host", [
    "claude-code",
    "codex",
  ] as const);
  const linkScope = enumFlag(parsed.flags["link-scope"], "--link-scope", [
    "user",
    "project",
    "local",
  ] as const);

  log(
    projectRoot
      ? `[ratel] connector project scope: ${projectRoot} (${resolution.projectRootSource})`
      : "[ratel] connector scope: user (no project root found)",
  );

  const attach = async () => {
    const token = await (options.readToken ?? readDaemonToken)(ctx.env.homeDir);
    if (!token) {
      throw new Error(
        `daemon is not installed; run \`npx -y @ratel-ai/ratel-local@${version} setup\``,
      );
    }
    return connectBackend({
      daemonUrl,
      token,
      projectRoot,
      clientVersion: version,
      ...(agentHost ? { agentHost } : {}),
      ...(linkScope ? { linkScope } : {}),
    });
  };

  const start =
    options.startDaemon ??
    (async () => {
      await runDaemon(
        {
          group: "daemon",
          verb: "start",
          configPaths: [],
          rest: [],
          extras: [],
          flags: {},
        },
        ctx,
        options,
        log,
      );
    });

  return runConnectorProxy({
    serverTransport: options.connectorTransport ?? new StdioServerTransport(),
    connectBackend: attach,
    daemonStatus: () =>
      options.daemonStatus
        ? options.daemonStatus(daemonUrl, ctx)
        : defaultDaemonStatus(daemonUrl, parsed, ctx),
    startDaemon: start,
    serverVersion: version,
    log,
  });
}

async function defaultConnectBackend(input: ConnectBackendInput): Promise<Client> {
  const client = new Client({
    name: "ratel-local-connector",
    version: input.clientVersion,
  });
  const transport = new StreamableHTTPClientTransport(input.daemonUrl, {
    requestInit: {
      headers: connectorHeaders(input.token, input.projectRoot, {
        agentHost: input.agentHost,
        linkScope: input.linkScope,
        connectorVersion: input.clientVersion,
      }),
    },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    await client.close().catch(() => undefined);
    throw err;
  }
}

async function defaultDaemonStatus(
  daemonUrl: URL,
  parsed: ParsedArgs,
  ctx: HandlerCtx,
): Promise<ConnectorDaemonStatus> {
  const port = Number(daemonUrl.port || "80");
  const status = await inspectDaemonService(
    { ...parsed, flags: { ...parsed.flags, port: String(port) } },
    ctx,
  );
  return { state: status.state };
}

async function resolveDaemonUrl(parsed: ParsedArgs, ctx: HandlerCtx): Promise<URL> {
  const flag = parsed.flags["daemon-url"];
  if (flag !== undefined && (typeof flag !== "string" || flag.length === 0)) {
    throw new Error("--daemon-url requires a URL value");
  }
  if (typeof flag === "string") return assertLoopbackMcpUrl(new URL(flag));
  try {
    const state = await readJson<DaemonState>(ctx.fs, daemonPaths(ctx.env.homeDir).state);
    if (!state) throw new Error("daemon state not found");
    return assertLoopbackMcpUrl(new URL(state.mcpUrl));
  } catch {
    return new URL(`http://127.0.0.1:${DEFAULT_DAEMON_PORT}/mcp`);
  }
}

function assertLoopbackMcpUrl(url: URL): URL {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    throw new Error("connector daemon URL must be an HTTP loopback address");
  }
  return url;
}

function enumFlag<const T extends readonly string[]>(
  value: unknown,
  name: string,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
