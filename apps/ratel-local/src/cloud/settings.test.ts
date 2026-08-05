import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudTraceSettingsStore, cloudTraceSettingsPath } from "./settings.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cloud trace settings store", () => {
  it("persists daemon-owned endpoint and credential with user-only permissions", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-settings-"));
    roots.push(homeDir);
    const path = cloudTraceSettingsPath(homeDir);
    const store = new CloudTraceSettingsStore(path);

    expect(await store.load()).toBeUndefined();
    await store.save({
      endpoint: "https://cloud.example.test/api/v1/traces",
      apiKey: "cloud-test-secret",
    });

    expect(await store.load()).toEqual({
      endpoint: "https://cloud.example.test/api/v1/traces",
      apiKey: "cloud-test-secret",
    });
    expect((await stat(join(homeDir, ".ratel"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed persisted settings", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-settings-"));
    roots.push(homeDir);
    const store = new CloudTraceSettingsStore(cloudTraceSettingsPath(homeDir));

    await expect(
      store.save({ endpoint: "http://cloud.example.test/traces", apiKey: "secret" }),
    ).rejects.toThrow(/HTTPS/i);
    await expect(
      store.save({ endpoint: "https://cloud.example.test/traces", apiKey: "" }),
    ).rejects.toThrow(/API key/i);
  });
});
