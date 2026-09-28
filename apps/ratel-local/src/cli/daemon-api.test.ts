import { join } from "node:path";
import type { BackupFs, JsonFs } from "@ratel-ai/ratel-local-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonLoopbackUrl, requestRunningDaemon, resolveSkillStorageFlag } from "./daemon-api.js";
import { daemonPaths } from "./handlers/daemon.js";
import type { HandlerCtx } from "./handlers/types.js";
import { silentPromptAdapter } from "./prompts.js";

const HOME = "/home/u";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("daemonLoopbackUrl", () => {
  it("constructs the URL from a valid persisted port", () => {
    expect(
      daemonLoopbackUrl(JSON.stringify({ port: 5731, uiUrl: "https://untrusted.example/daemon" })),
    ).toBe("http://127.0.0.1:5731");
  });

  it.each([0, -1, 65536, 1.5, "5731", null])("rejects invalid daemon port %j", (port) => {
    expect(daemonLoopbackUrl(JSON.stringify({ port }))).toBeNull();
  });
});

describe("requestRunningDaemon", () => {
  it("sends credentials only to the loopback URL derived from the daemon port", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(
      JSON.stringify({ port: 5731, uiUrl: "https://untrusted.example/daemon" }),
      "secret-token\n",
    );

    const response = await requestRunningDaemon(ctx, "/api/ui/sessions", { method: "POST" });

    expect(response?.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toBe("http://127.0.0.1:5731/api/ui/sessions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
  });

  it("does not send credentials when the persisted port is invalid", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ctx = makeCtx(
      JSON.stringify({ port: 70000, uiUrl: "https://untrusted.example/daemon" }),
      "secret-token",
    );

    await expect(requestRunningDaemon(ctx, "/api/projects")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveSkillStorageFlag", () => {
  const ctx = makeCtx(JSON.stringify({ port: 5731 }), "token");

  it("follows a running daemon, on or off", async () => {
    await expect(
      resolveSkillStorageFlag(ctx, async () =>
        Response.json({ skillStorage: true }, { status: 200 }),
      ),
    ).resolves.toBe(true);
    await expect(
      resolveSkillStorageFlag(ctx, async () =>
        Response.json({ skillStorage: false }, { status: 200 }),
      ),
    ).resolves.toBe(false);
  });

  it("falls back to this process's environment when the daemon is unreachable", async () => {
    const previous = process.env.RATEL_FEATURE_SKILL_STORAGE;
    try {
      process.env.RATEL_FEATURE_SKILL_STORAGE = "1";
      await expect(resolveSkillStorageFlag(ctx, async () => null)).resolves.toBe(true);
      delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      await expect(resolveSkillStorageFlag(ctx, async () => null)).resolves.toBe(false);
    } finally {
      if (previous === undefined) delete process.env.RATEL_FEATURE_SKILL_STORAGE;
      else process.env.RATEL_FEATURE_SKILL_STORAGE = previous;
    }
  });
});

function makeCtx(stateText: string, token: string): HandlerCtx {
  const files = new Map([
    [daemonPaths(HOME).state, stateText],
    [join(HOME, ".ratel", "daemon-token"), token],
  ]);
  const fs: JsonFs & BackupFs = {
    read: async (path) => files.get(path) ?? null,
    writeAtomic: async () => {},
    exists: async (path) => files.has(path),
    write: async () => {},
    remove: async () => {},
    mkdirp: async () => {},
    list: async () => [],
  };
  return {
    argv: { group: "ui", configPaths: [], rest: [], extras: [], flags: {} },
    env: { homeDir: HOME },
    fs,
    log: () => {},
    prompts: silentPromptAdapter(),
  };
}
