import type { IncomingMessage } from "node:http";
import type { InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  projectIdFromCanonicalRoot,
  type RuntimeContextRef,
  type RuntimeRevision,
} from "@ratel-ai/ratel-local-core";
import type { ActiveMcpClientReader, ActiveMcpClientSummary } from "../ui/routes.js";
import {
  type AgentLinkScope,
  connectorMetadataFromHeaders,
  type DeclaredAgentHost,
} from "./access.js";

export interface PendingMcpClientRegistration {
  name: string;
  version: string;
  protocolVersion: string;
  title?: string;
  userAgent?: string;
  remoteAddress?: string;
  capabilities: string[];
  context: RuntimeContextRef;
  runtimeRevision: RuntimeRevision;
  scope: "user" | "project";
  scopeKey: string;
  projectRoot?: string;
  connectorProtocolVersion?: string;
  agentHost?: DeclaredAgentHost;
  linkScope?: AgentLinkScope;
  connectorVersion?: string;
}

interface ActiveMcpClientRecord extends ActiveMcpClientSummary {
  closedAt?: string;
}

export class InMemoryMcpClientRegistry implements ActiveMcpClientReader {
  private clients = new Map<string, ActiveMcpClientRecord>();
  private currentRevisions = new Map<string, RuntimeRevision>();
  private invalidContexts = new Map<string, string>();

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
      context: registration.context,
      runtimeRevision: registration.runtimeRevision,
      stale: false,
      scope: registration.scope,
      scopeKey: registration.scopeKey,
      ...(registration.projectRoot ? { projectRoot: registration.projectRoot } : {}),
      ...(registration.connectorProtocolVersion
        ? { connectorProtocolVersion: registration.connectorProtocolVersion }
        : {}),
      ...(registration.agentHost ? { agentHost: registration.agentHost } : {}),
      ...(registration.linkScope ? { linkScope: registration.linkScope } : {}),
      ...(registration.connectorVersion ? { connectorVersion: registration.connectorVersion } : {}),
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
        context: client.context,
        runtimeRevision: client.runtimeRevision,
        stale:
          this.invalidContexts.has(contextKey(client.context)) ||
          (this.currentRevisions.get(contextKey(client.context)) !== undefined &&
            this.currentRevisions.get(contextKey(client.context)) !== client.runtimeRevision),
        scope: client.scope,
        scopeKey: client.scopeKey,
        ...(client.projectRoot ? { projectRoot: client.projectRoot } : {}),
        ...(client.connectorProtocolVersion
          ? { connectorProtocolVersion: client.connectorProtocolVersion }
          : {}),
        ...(client.agentHost ? { agentHost: client.agentHost } : {}),
        ...(client.linkScope ? { linkScope: client.linkScope } : {}),
        ...(client.connectorVersion ? { connectorVersion: client.connectorVersion } : {}),
      }));
  }

  setCurrentRevision(context: RuntimeContextRef, revision: RuntimeRevision): void {
    const key = contextKey(context);
    this.currentRevisions.set(key, revision);
    this.invalidContexts.delete(key);
  }

  setInvalidContext(context: RuntimeContextRef, message: string): void {
    this.invalidContexts.set(contextKey(context), message);
  }

  currentRevision(context: RuntimeContextRef): RuntimeRevision | undefined {
    return this.currentRevisions.get(contextKey(context));
  }
}

export interface PendingMcpClientContext {
  context?: RuntimeContextRef;
  runtimeRevision?: RuntimeRevision;
  scope?: "user" | "project";
  scopeKey?: string;
  projectRoot?: string;
}

export function pendingRegistrationFromInitialize(
  req: IncomingMessage,
  message: InitializeRequest,
  input: PendingMcpClientContext = {},
): PendingMcpClientRegistration {
  const { clientInfo, protocolVersion, capabilities } = message.params;
  const context =
    input.context ??
    (input.scope === "project" && input.projectRoot
      ? {
          kind: "project" as const,
          projectId: projectIdFromCanonicalRoot(input.projectRoot),
        }
      : { kind: "global" as const });
  const scope = context.kind === "project" ? "project" : "user";
  const scopeKey =
    input.scopeKey ?? (context.kind === "project" ? `project:${context.projectId}` : "global");
  return {
    name: clientInfo.name,
    version: clientInfo.version,
    protocolVersion,
    ...(clientInfo.title ? { title: clientInfo.title } : {}),
    ...userAgentHeader(req.headers["user-agent"]),
    ...(req.socket.remoteAddress ? { remoteAddress: req.socket.remoteAddress } : {}),
    capabilities: capabilityNames(capabilities),
    ...connectorMetadataFromHeaders(req.headers),
    context,
    runtimeRevision: input.runtimeRevision ?? ("legacy" as RuntimeRevision),
    scope,
    scopeKey,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
  };
}

function contextKey(context: RuntimeContextRef): string {
  return context.kind === "global" ? "global" : `project:${context.projectId}`;
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
