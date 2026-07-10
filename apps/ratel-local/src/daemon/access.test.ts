import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONNECTOR_PROTOCOL_VERSION,
  connectorHeaders,
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
