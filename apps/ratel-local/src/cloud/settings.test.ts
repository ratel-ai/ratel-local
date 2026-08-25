import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CloudProfileError,
  CloudSettingsStore,
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

function store(homeDir: string) {
  return new CloudSettingsStore(cloudSettingsPath(homeDir), legacyCloudSettingsPath(homeDir));
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

    expect(await store(homeDir).load()).toEqual({
      tracesEndpoint: ENDPOINT,
      default: "default",
      profiles: { default: { apiKey: "rtl_legacy" } },
    });
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

    expect((await store(homeDir).load())?.profiles).toEqual({
      personal: { apiKey: "rtl_personal" },
    });
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
    expect(resolveCloudCredential(settings, { source: "store default" })).toEqual({
      apiKey: "rtl_personal",
      tracesEndpoint: ENDPOINT,
      profile: "personal",
      source: "store default",
    });
  });

  it("uses the selected profile and keeps its source", () => {
    const resolved = resolveCloudCredential(settings, {
      profile: "acme",
      source: "./.ratel/config.json",
    });
    expect(resolved.apiKey).toBe("rtl_acme");
    expect(resolved.source).toBe("./.ratel/config.json");
  });

  it("fails on an unknown profile, naming it and where it was asked for", async () => {
    // Never a quiet fall back to the default: that is how one project's
    // telemetry reaches another project's Cloud account.
    expect(() =>
      resolveCloudCredential(settings, { profile: "ghost", source: "./.ratel/config.json" }),
    ).toThrow(CloudProfileError);
    expect(() =>
      resolveCloudCredential(settings, { profile: "ghost", source: "./.ratel/config.json" }),
    ).toThrow(/"ghost" \(\.\/\.ratel\/config\.json\).*known profiles: acme, personal/);
  });

  it("fails when there is no selection and no default", () => {
    expect(() =>
      resolveCloudCredential({ tracesEndpoint: ENDPOINT, profiles: {} }, { source: "none" }),
    ).toThrow(/no Cloud profile is selected/);
  });
});
