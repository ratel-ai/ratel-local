import type { IncomingMessage } from "node:http";
import type { InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ActiveMcpClientReader, ActiveMcpClientSummary } from "../ui/routes.js";

export interface PendingMcpClientRegistration {
  name: string;
  version: string;
  protocolVersion: string;
  title?: string;
  userAgent?: string;
  remoteAddress?: string;
  capabilities: string[];
  scope: "user" | "project";
  scopeKey: string;
  projectRoot?: string;
}

interface ActiveMcpClientRecord extends ActiveMcpClientSummary {
  closedAt?: string;
}

export class InMemoryMcpClientRegistry implements ActiveMcpClientReader {
  private clients = new Map<string, ActiveMcpClientRecord>();

  register(sessionId: string, registration: PendingMcpClientRegistration, now = new Date()): void {
    const timestamp = now.toISOString();
    this.clients.set(sessionId, {
      sessionId,
      name: registration.name,
      version: registration.version,
      protocolVersion: registration.protocolVersion,
      connectedAt: timestamp,
      lastSeenAt: timestamp,
      requestCount: 1,
      ...(registration.title ? { title: registration.title } : {}),
      ...(registration.userAgent ? { userAgent: registration.userAgent } : {}),
      ...(registration.remoteAddress ? { remoteAddress: registration.remoteAddress } : {}),
      capabilities: registration.capabilities,
      scope: registration.scope,
      scopeKey: registration.scopeKey,
      ...(registration.projectRoot ? { projectRoot: registration.projectRoot } : {}),
    });
  }

  markSeen(sessionId: string, now = new Date()): void {
    const client = this.clients.get(sessionId);
    if (!client || client.closedAt) return;
    client.lastSeenAt = now.toISOString();
    client.requestCount += 1;
  }

  close(sessionId: string, now = new Date()): void {
    const client = this.clients.get(sessionId);
    if (!client) return;
    client.closedAt = now.toISOString();
    this.clients.delete(sessionId);
  }

  listActiveClients(): ActiveMcpClientSummary[] {
    return Array.from(this.clients.values())
      .filter((client) => !client.closedAt)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((client) => ({
        sessionId: client.sessionId,
        name: client.name,
        version: client.version,
        protocolVersion: client.protocolVersion,
        connectedAt: client.connectedAt,
        lastSeenAt: client.lastSeenAt,
        requestCount: client.requestCount,
        ...(client.title ? { title: client.title } : {}),
        ...(client.userAgent ? { userAgent: client.userAgent } : {}),
        ...(client.remoteAddress ? { remoteAddress: client.remoteAddress } : {}),
        capabilities: [...client.capabilities],
        scope: client.scope,
        scopeKey: client.scopeKey,
        ...(client.projectRoot ? { projectRoot: client.projectRoot } : {}),
      }));
  }
}

export function pendingRegistrationFromInitialize(
  req: IncomingMessage,
  message: InitializeRequest,
  scope: Pick<PendingMcpClientRegistration, "scope" | "scopeKey" | "projectRoot"> = {
    scope: "user",
    scopeKey: "user",
  },
): PendingMcpClientRegistration {
  const { clientInfo, protocolVersion, capabilities } = message.params;
  return {
    name: clientInfo.name,
    version: clientInfo.version,
    protocolVersion,
    ...(clientInfo.title ? { title: clientInfo.title } : {}),
    ...userAgentHeader(req.headers["user-agent"]),
    ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
    capabilities: capabilityNames(capabilities),
    ...scope,
  };
}

function userAgentHeader(value: string | string[] | undefined): { userAgent?: string } {
  const header = Array.isArray(value) ? value.join(", ") : value;
  return header ? { userAgent: header } : {};
}

function capabilityNames(capabilities: InitializeRequest["params"]["capabilities"]): string[] {
  return Object.entries(capabilities)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .sort();
}
