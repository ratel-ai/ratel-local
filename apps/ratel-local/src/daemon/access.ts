import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

export const CONNECTOR_PROTOCOL_VERSION = "2";
export const CONNECTOR_PROTOCOL_HEADER = "x-ratel-connector-protocol";
export const PROJECT_ROOT_HEADER = "x-ratel-project-root";
export const AGENT_HOST_HEADER = "x-ratel-agent-host";
export const LINK_SCOPE_HEADER = "x-ratel-link-scope";
export const CONNECTOR_VERSION_HEADER = "x-ratel-connector-version";
const LEGACY_CONNECTOR_PROTOCOL_VERSION = "1";

export type DeclaredAgentHost = "claude-code" | "codex";
export type AgentLinkScope = "user" | "project" | "local";

export interface ConnectorMetadata {
  connectorProtocolVersion?: string;
  agentHost?: DeclaredAgentHost;
  linkScope?: AgentLinkScope;
  connectorVersion?: string;
}

export type DaemonRequestScope = { kind: "user" } | { kind: "project"; projectRoot: string };

export class DaemonAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DaemonAccessError";
  }
}

export function daemonTokenPath(homeDir: string): string {
  return join(homeDir, ".ratel", "daemon-token");
}

export async function ensureDaemonToken(homeDir: string): Promise<string> {
  const ratelDir = join(homeDir, ".ratel");
  const path = daemonTokenPath(homeDir);
  await mkdir(ratelDir, { recursive: true });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!existing) throw new Error(`daemon token at ${path} is empty`);
    await chmod(path, 0o600);
    return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${token}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = (await readFile(path, "utf8")).trim();
    if (!existing) throw new Error(`daemon token at ${path} is empty`);
    await chmod(path, 0o600);
    return existing;
  }
}

export async function readDaemonToken(homeDir: string): Promise<string | null> {
  try {
    const token = (await readFile(daemonTokenPath(homeDir), "utf8")).trim();
    return token || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function connectorHeaders(
  token: string,
  projectRoot?: string,
  metadata: Omit<ConnectorMetadata, "connectorProtocolVersion"> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    [CONNECTOR_PROTOCOL_HEADER]: CONNECTOR_PROTOCOL_VERSION,
    ...(projectRoot
      ? { [PROJECT_ROOT_HEADER]: Buffer.from(projectRoot, "utf8").toString("base64url") }
      : {}),
    ...(metadata.agentHost ? { [AGENT_HOST_HEADER]: metadata.agentHost } : {}),
    ...(metadata.linkScope ? { [LINK_SCOPE_HEADER]: metadata.linkScope } : {}),
    ...(metadata.connectorVersion ? { [CONNECTOR_VERSION_HEADER]: metadata.connectorVersion } : {}),
  };
}

export function connectorMetadataFromHeaders(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): ConnectorMetadata {
  const connectorProtocolVersion = firstHeader(headers[CONNECTOR_PROTOCOL_HEADER]);
  if (connectorProtocolVersion !== CONNECTOR_PROTOCOL_VERSION) {
    return connectorProtocolVersion ? { connectorProtocolVersion } : {};
  }

  const agentHost = firstHeader(headers[AGENT_HOST_HEADER]);
  const linkScope = firstHeader(headers[LINK_SCOPE_HEADER]);
  const connectorVersion = firstHeader(headers[CONNECTOR_VERSION_HEADER]);
  if (agentHost !== undefined && agentHost !== "claude-code" && agentHost !== "codex") {
    throw new DaemonAccessError(`invalid connector agent host: ${agentHost}`, 400);
  }
  if (
    linkScope !== undefined &&
    linkScope !== "user" &&
    linkScope !== "project" &&
    linkScope !== "local"
  ) {
    throw new DaemonAccessError(`invalid connector link scope: ${linkScope}`, 400);
  }
  if (
    connectorVersion !== undefined &&
    (!connectorVersion || connectorVersion.length > 256 || connectorVersion.includes("\0"))
  ) {
    throw new DaemonAccessError("invalid connector version", 400);
  }
  return {
    connectorProtocolVersion,
    ...(agentHost ? { agentHost } : {}),
    ...(linkScope ? { linkScope } : {}),
    ...(connectorVersion ? { connectorVersion } : {}),
  };
}

export async function resolveDaemonRequestScope(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  expectedToken: string,
): Promise<DaemonRequestScope> {
  authorizeDaemonRequest(headers, expectedToken);
  const encodedRoot = firstHeader(headers[PROJECT_ROOT_HEADER]);
  const protocol = connectorMetadataFromHeaders(headers).connectorProtocolVersion;
  if (protocol !== undefined && !isSupportedConnectorProtocol(protocol)) {
    throw new DaemonAccessError(
      `unsupported connector protocol ${protocol}; expected ${LEGACY_CONNECTOR_PROTOCOL_VERSION} or ${CONNECTOR_PROTOCOL_VERSION}`,
      426,
    );
  }
  if (!encodedRoot) return { kind: "user" };
  if (!protocol || !isSupportedConnectorProtocol(protocol)) {
    throw new DaemonAccessError(
      "project-scoped connections require a compatible connector protocol",
      426,
    );
  }
  if (encodedRoot.length > 8_192) {
    throw new DaemonAccessError("project root header is too large", 400);
  }

  let decoded: string;
  try {
    decoded = Buffer.from(encodedRoot, "base64url").toString("utf8");
  } catch {
    throw new DaemonAccessError("project root header is invalid", 400);
  }
  if (!decoded || decoded.includes("\0")) {
    throw new DaemonAccessError("project root header is invalid", 400);
  }

  try {
    const canonical = await realpath(decoded);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("not a directory");
    return { kind: "project", projectRoot: canonical };
  } catch (err) {
    throw new DaemonAccessError(`project root is unavailable: ${(err as Error).message}`, 400);
  }
}

function isSupportedConnectorProtocol(protocol: string): boolean {
  return protocol === LEGACY_CONNECTOR_PROTOCOL_VERSION || protocol === CONNECTOR_PROTOCOL_VERSION;
}

export function authorizeDaemonRequest(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  expectedToken: string,
): void {
  const authorization = firstHeader(headers.authorization);
  if (!authorization?.startsWith("Bearer ")) {
    throw new DaemonAccessError("unauthorized daemon request", 401);
  }
  const receivedToken = authorization.slice("Bearer ".length);
  if (!sameSecret(receivedToken, expectedToken)) {
    throw new DaemonAccessError("unauthorized daemon request", 401);
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
