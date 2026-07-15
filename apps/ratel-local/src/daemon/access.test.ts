import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_PROTOCOL_VERSION,
  connectorHeaders,
  connectorMetadataFromHeaders,
  ensureDaemonToken,
  resolveDaemonRequestScope,
} from "./access.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon access", () => {
  it("creates and reuses a private daemon token", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-access-"));
    cleanup.push(homeDir);

    const first = await ensureDaemonToken(homeDir);
    const second = await ensureDaemonToken(homeDir);

    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect((await readFile(join(homeDir, ".ratel", "daemon-token"), "utf8")).trim()).toBe(first);
    expect((await stat(join(homeDir, ".ratel", "daemon-token"))).mode & 0o777).toBe(0o600);
  });

  it("authenticates and canonicalizes a connector project scope", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-project-"));
    cleanup.push(homeDir);
    const token = "test-token";
    const headers = connectorHeaders(token, homeDir);

    const scope = await resolveDaemonRequestScope(headers, token);

    expect(scope).toEqual({ kind: "project", projectRoot: await realpath(homeDir) });
    expect(headers["x-ratel-connector-protocol"]).toBe(CONNECTOR_PROTOCOL_VERSION);
  });

  it("emits and parses declared connector v2 metadata", () => {
    const headers = connectorHeaders("test-token", "/repo", {
      agentHost: "codex",
      linkScope: "project",
      connectorVersion: "1.2.3",
    });

    expect(headers).toMatchObject({
      "x-ratel-connector-protocol": "2",
      "x-ratel-agent-host": "codex",
      "x-ratel-link-scope": "project",
      "x-ratel-connector-version": "1.2.3",
    });
    expect(connectorMetadataFromHeaders(headers)).toEqual({
      connectorProtocolVersion: "2",
      agentHost: "codex",
      linkScope: "project",
      connectorVersion: "1.2.3",
    });
  });

  it("accepts protocol v1 project connections without declared metadata", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ratel-project-v1-"));
    cleanup.push(projectRoot);
    const headers = {
      authorization: "Bearer test-token",
      "x-ratel-connector-protocol": "1",
      "x-ratel-project-root": Buffer.from(projectRoot).toString("base64url"),
    };

    await expect(resolveDaemonRequestScope(headers, "test-token")).resolves.toEqual({
      kind: "project",
      projectRoot: await realpath(projectRoot),
    });
    expect(connectorMetadataFromHeaders(headers)).toEqual({ connectorProtocolVersion: "1" });
  });

  it("rejects an invalid declared agent host in protocol v2", async () => {
    await expect(
      resolveDaemonRequestScope(
        {
          authorization: "Bearer test-token",
          "x-ratel-connector-protocol": "2",
          "x-ratel-agent-host": "other-agent",
        },
        "test-token",
      ),
    ).rejects.toThrow(/agent host/i);
  });

  it("uses user scope when an authenticated client sends no project root", async () => {
    await expect(
      resolveDaemonRequestScope({ authorization: "Bearer test-token" }, "test-token"),
    ).resolves.toEqual({ kind: "user" });
  });

  it("rejects missing auth, protocol mismatches, and nonexistent roots", async () => {
    await expect(resolveDaemonRequestScope({}, "test-token")).rejects.toThrow(/unauthorized/i);
    await expect(
      resolveDaemonRequestScope(
        {
          authorization: "Bearer test-token",
          "x-ratel-connector-protocol": "999",
          "x-ratel-project-root": Buffer.from("/tmp").toString("base64url"),
        },
        "test-token",
      ),
    ).rejects.toThrow(/protocol/i);
    await expect(
      resolveDaemonRequestScope(
        connectorHeaders("test-token", "/definitely/missing"),
        "test-token",
      ),
    ).rejects.toThrow(/project root/i);
  });
});
