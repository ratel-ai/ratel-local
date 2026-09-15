import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CloudTraceSettingsStore,
  cloudOtlpRelayOptionsFromEnv,
  cloudTraceSettingsPath,
} from "./trace-settings.js";

const CLOUD_ENDPOINT = "https://cloud.example.test/otlp/v1/traces";
const CLOUD_SECRET = "cloud-secret-must-not-leak";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function homeWithRatelDir(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-traces-"));
  roots.push(homeDir);
  await mkdir(join(homeDir, ".ratel"), { recursive: true, mode: 0o700 });
  return homeDir;
}

describe("Cloud OTLP trace relay configuration", () => {
  it("requires no feature flag and activates when daemon-owned environment values are present", () => {
    expect(cloudOtlpRelayOptionsFromEnv({})).toBeUndefined();
    expect(() =>
      cloudOtlpRelayOptionsFromEnv({
        RATEL_CLOUD_OTLP_TRACES_ENDPOINT: CLOUD_ENDPOINT,
      }),
    ).toThrow(/credential/i);

    expect(
      cloudOtlpRelayOptionsFromEnv({
        RATEL_CLOUD_OTLP_TRACES_ENDPOINT: CLOUD_ENDPOINT,
        RATEL_API_KEY: CLOUD_SECRET,
      }),
    ).toMatchObject({
      endpoint: new URL(CLOUD_ENDPOINT),
      logsEndpoint: new URL("https://cloud.example.test/api/v1/logs"),
      apiKey: CLOUD_SECRET,
    });
  });

  it("requires a secret-free HTTPS Cloud endpoint", () => {
    for (const endpoint of [
      "http://cloud.example.test/otlp/v1/traces",
      "https://key@cloud.example.test/otlp/v1/traces",
      "https://cloud.example.test/otlp/v1/traces?api_key=secret",
      "not-a-url",
    ]) {
      expect(() =>
        cloudOtlpRelayOptionsFromEnv({
          RATEL_CLOUD_OTLP_TRACES_ENDPOINT: endpoint,
          RATEL_API_KEY: CLOUD_SECRET,
        }),
      ).toThrow(/endpoint/i);
    }
  });
});

describe("Cloud trace settings store", () => {
  it("persists one endpoint and one key with user-only permissions", async () => {
    const homeDir = await homeWithRatelDir();
    const store = new CloudTraceSettingsStore(cloudTraceSettingsPath(homeDir));
    await store.save({ endpoint: CLOUD_ENDPOINT, apiKey: CLOUD_SECRET });

    expect((await stat(cloudTraceSettingsPath(homeDir))).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual({ endpoint: CLOUD_ENDPOINT, apiKey: CLOUD_SECRET });
  });

  it("reports nothing when no store exists, and refuses an unusable one", async () => {
    const homeDir = await homeWithRatelDir();
    const store = new CloudTraceSettingsStore(cloudTraceSettingsPath(homeDir));
    expect(await store.load()).toBeUndefined();
    await expect(
      store.save({ endpoint: "http://cloud.example.test/otlp/v1/traces", apiKey: CLOUD_SECRET }),
    ).rejects.toThrow(/HTTPS/);
  });
});
