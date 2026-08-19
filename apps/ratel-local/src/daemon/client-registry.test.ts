import type { IncomingMessage } from "node:http";
import type { InitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ProjectId, RuntimeRevision } from "@ratel-ai/ratel-local-core";
import { describe, expect, it } from "vitest";
import { connectorHeaders } from "./access.js";
import { InMemoryMcpClientRegistry, pendingRegistrationFromInitialize } from "./client-registry.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: { roots: {} },
    clientInfo: { name: "ratel-local-connector", version: "1.2.3" },
  },
} as InitializeRequest;

describe("MCP client registry", () => {
  it("exposes declared connector v2 metadata in the active client summary", () => {
    const request = {
      headers: connectorHeaders("token", undefined, {
        agentHost: "claude-code",
        linkScope: "local",
        connectorVersion: "1.2.3",
      }),
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage;
    const registration = pendingRegistrationFromInitialize(request, initializeRequest);
    const registry = new InMemoryMcpClientRegistry();

    registry.register("session-1", registration, new Date("2026-07-15T12:00:00.000Z"));

    expect(registry.listActiveClients()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        connectorProtocolVersion: "2",
        agentHost: "claude-code",
        linkScope: "local",
        connectorVersion: "1.2.3",
      }),
    ]);
  });

  it("keeps declared metadata absent for a protocol v1 connector", () => {
    const request = {
      headers: {
        authorization: "Bearer token",
        "x-ratel-connector-protocol": "1",
        "x-ratel-agent-host": "codex",
        "x-ratel-link-scope": "user",
        "x-ratel-connector-version": "legacy-header-is-not-v1-metadata",
      },
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage;
    const registry = new InMemoryMcpClientRegistry();

    registry.register(
      "legacy-session",
      pendingRegistrationFromInitialize(request, initializeRequest),
    );

    expect(registry.listActiveClients()[0]).toMatchObject({
      connectorProtocolVersion: "1",
    });
    expect(registry.listActiveClients()[0]).not.toHaveProperty("agentHost");
    expect(registry.listActiveClients()[0]).not.toHaveProperty("linkScope");
    expect(registry.listActiveClients()[0]).not.toHaveProperty("connectorVersion");
  });

  it("records the immutable project context and marks old revisions stale", () => {
    const projectId = "prj_context" as ProjectId;
    const request = {
      headers: connectorHeaders("token", "/repo"),
      socket: { remoteAddress: "127.0.0.1" },
    } as IncomingMessage;
    const registry = new InMemoryMcpClientRegistry();
    const registration = pendingRegistrationFromInitialize(request, initializeRequest, {
      context: { kind: "project", projectId },
      projectRoot: "/repo",
      runtimeRevision: "rev-one" as RuntimeRevision,
    });

    registry.register("session-project", registration);
    expect(registry.listActiveClients()[0]).toMatchObject({
      context: { kind: "project", projectId },
      projectRoot: "/repo",
      runtimeRevision: "rev-one",
      stale: false,
    });

    registry.setCurrentRevision({ kind: "project", projectId }, "rev-two" as RuntimeRevision);
    expect(registry.listActiveClients()[0]).toMatchObject({ stale: true });
    expect(registry.currentRevision({ kind: "project", projectId })).toBe("rev-two");

    registry.setCurrentRevision({ kind: "project", projectId }, "rev-one" as RuntimeRevision);
    registry.setInvalidContext({ kind: "project", projectId }, "invalid config");
    expect(registry.listActiveClients()[0]).toMatchObject({ stale: true });

    registry.setCurrentRevision({ kind: "project", projectId }, "rev-one" as RuntimeRevision);
    expect(registry.listActiveClients()[0]).toMatchObject({ stale: false });
  });
});
