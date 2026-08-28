import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CloudSettingsStore,
  cloudEndpoints,
  cloudSettingsPath,
  legacyCloudSettingsPath,
  resolveCloudCredential,
} from "./settings.js";

const ENDPOINT = "https://cloud.example.test/api/v1/traces";
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function homeWithRatelDir(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "ratel-cloud-settings-"));
  roots.push(homeDir);
  await mkdir(join(homeDir, ".ratel"), { recursive: true, mode: 0o700 });
  return homeDir;
}

function store(homeDir: string, log: (message: string) => void = () => {}) {
  return new CloudSettingsStore(cloudSettingsPath(homeDir), legacyCloudSettingsPath(homeDir), log);
}

describe("Cloud settings store", () => {
  it("persists profiles with user-only permissions", async () => {
    const homeDir = await homeWithRatelDir();
    await store(homeDir).save({
      tracesEndpoint: ENDPOINT,
      default: "personal",
      profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
    });

    const path = cloudSettingsPath(homeDir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(homeDir, ".ratel"))).mode & 0o777).toBe(0o700);
    expect(await store(homeDir).load()).toEqual({
      tracesEndpoint: ENDPOINT,
      default: "personal",
      profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
    });
  });

  it("migrates the pre-profile store into a single default profile", async () => {
    const homeDir = await homeWithRatelDir();
    await writeFile(
      legacyCloudSettingsPath(homeDir),
      JSON.stringify({ endpoint: ENDPOINT, apiKey: "rtl_legacy" }),
      { encoding: "utf8", mode: 0o600 },
    );

    const logs: string[] = [];
    // The old file's origin becomes the deployment; its path is the standard one,
    // so nothing needs to be carried over as an override.
    expect(await store(homeDir, (m) => logs.push(m)).load()).toEqual({
      baseUrl: "https://cloud.example.test",
      default: "default",
      profiles: { default: { apiKey: "rtl_legacy" } },
    });
    // The operator is told which file was read and that it outlives its use.
    expect(logs.join("\n")).toContain(legacyCloudSettingsPath(homeDir));
    expect(logs.join("\n")).toContain("still holds a key");
    // Reading is not migrating: the old file is left exactly as it was.
    expect(JSON.parse(await readFile(legacyCloudSettingsPath(homeDir), "utf8"))).toEqual({
      endpoint: ENDPOINT,
      apiKey: "rtl_legacy",
    });
  });

  it("prefers the current store over the legacy one", async () => {
    const homeDir = await homeWithRatelDir();
    await writeFile(
      legacyCloudSettingsPath(homeDir),
      JSON.stringify({ endpoint: ENDPOINT, apiKey: "rtl_legacy" }),
      { encoding: "utf8", mode: 0o600 },
    );
    await store(homeDir).save({
      tracesEndpoint: ENDPOINT,
      default: "personal",
      profiles: { personal: { apiKey: "rtl_personal" } },
    });

    const logs: string[] = [];
    expect((await store(homeDir, (m) => logs.push(m)).load())?.profiles).toEqual({
      personal: { apiKey: "rtl_personal" },
    });
    // Nothing to say when the current store wins.
    expect(logs).toEqual([]);
  });

  it("reports nothing when neither file exists", async () => {
    expect(await store(await homeWithRatelDir()).load()).toBeUndefined();
  });

  it("rejects malformed and unusable settings", async () => {
    const homeDir = await homeWithRatelDir();
    await writeFile(cloudSettingsPath(homeDir), "{not json", { encoding: "utf8", mode: 0o600 });
    await expect(store(homeDir).load()).rejects.toThrow(/not valid JSON/);

    await writeFile(cloudSettingsPath(homeDir), JSON.stringify({ profiles: { a: {} } }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await expect(store(homeDir).load()).rejects.toThrow(/malformed/);

    // A default nobody defines would resolve to nothing at startup.
    await expect(
      store(homeDir).save({ tracesEndpoint: ENDPOINT, default: "absent", profiles: {} }),
    ).rejects.toThrow(/default profile "absent" is not defined/);

    await expect(
      store(homeDir).save({
        tracesEndpoint: "http://cloud.example.test/api/v1/traces",
        profiles: { a: { apiKey: "rtl_a" } },
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe("resolveCloudCredential", () => {
  const settings = {
    tracesEndpoint: ENDPOINT,
    default: "personal",
    profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
  };

  it("falls back to the store default when nothing selects a profile", () => {
    expect(resolveCloudCredential(settings, { source: "store default" })).toBe("rtl_personal");
  });

  it("puts every signal on the configured deployment, and only what is overridden elsewhere", () => {
    expect(cloudEndpoints().catalog.toString()).toBe("https://cloud.ratel.sh/api/v1/catalog");

    const staging = cloudEndpoints({ baseUrl: "https://staging.ratel.sh", profiles: {} });
    expect([staging.traces, staging.logs, staging.catalog].map(String)).toEqual([
      "https://staging.ratel.sh/api/v1/traces",
      "https://staging.ratel.sh/api/v1/logs",
      "https://staging.ratel.sh/api/v1/catalog",
    ]);

    // One signal aimed elsewhere moves alone; the rest stay on the deployment.
    const mixed = cloudEndpoints({
      baseUrl: "https://staging.ratel.sh",
      catalogEndpoint: "https://scratch.example.test/api/v1/catalog",
      profiles: {},
    });
    expect(mixed.catalog.toString()).toBe("https://scratch.example.test/api/v1/catalog");
    expect(mixed.traces.toString()).toBe("https://staging.ratel.sh/api/v1/traces");
  });

  it("uses the named profile over the default", () => {
    const resolved = resolveCloudCredential(settings, {
      profile: "acme",
      source: "RATEL_PROFILE environment",
    });
    expect(resolved).toBe("rtl_acme");
  });

  it("fails on an unknown profile, naming it and where it was asked for", () => {
    // Never a quiet fall back to the default: that is how one project's
    // telemetry reaches another project's Cloud account.
    expect(() =>
      resolveCloudCredential(settings, { profile: "ghost", source: "./.ratel/config.json" }),
    ).toThrow(/"ghost" \(\.\/\.ratel\/config\.json\).*known profiles: acme, personal/);
  });

  it("resolves nothing when the store is empty rather than failing", () => {
    expect(
      resolveCloudCredential({ tracesEndpoint: ENDPOINT, profiles: {} }, { source: "none" }),
    ).toBeUndefined();
  });
});
