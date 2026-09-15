import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CloudSettingsStore,
  cloudEndpoints,
  cloudSettingsPath,
  resolveCloudCredential,
} from "./settings.js";

const CATALOG = "https://cloud.example.test/api/v1/catalog";
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
  return new CloudSettingsStore(cloudSettingsPath(homeDir));
}

describe("Cloud settings store", () => {
  it("persists profiles with user-only permissions", async () => {
    const homeDir = await homeWithRatelDir();
    await store(homeDir).save({
      catalogEndpoint: CATALOG,
      default: "personal",
      profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
    });

    const path = cloudSettingsPath(homeDir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(homeDir, ".ratel"))).mode & 0o777).toBe(0o700);
    expect(await store(homeDir).load()).toEqual({
      catalogEndpoint: CATALOG,
      default: "personal",
      profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
    });
  });

  it("reports nothing when no store exists", async () => {
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
      store(homeDir).save({ catalogEndpoint: CATALOG, default: "absent", profiles: {} }),
    ).rejects.toThrow(/default profile "absent" is not defined/);

    await expect(
      store(homeDir).save({
        catalogEndpoint: "http://cloud.example.test/api/v1/catalog",
        profiles: { a: { apiKey: "rtl_a" } },
      }),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe("resolveCloudCredential", () => {
  const settings = {
    catalogEndpoint: CATALOG,
    default: "personal",
    profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
  };

  it("falls back to the store default when nothing selects a profile", () => {
    expect(resolveCloudCredential(settings, { source: "store default" })).toBe("rtl_personal");
  });

  it("puts the catalog on the configured deployment, unless it is overridden", () => {
    expect(cloudEndpoints().catalog.toString()).toBe("https://cloud.ratel.sh/api/v1/catalog");
    expect(
      cloudEndpoints({ baseUrl: "https://staging.ratel.sh", profiles: {} }).catalog.toString(),
    ).toBe("https://staging.ratel.sh/api/v1/catalog");
    expect(
      cloudEndpoints({
        baseUrl: "https://staging.ratel.sh",
        catalogEndpoint: "https://scratch.example.test/api/v1/catalog",
        profiles: {},
      }).catalog.toString(),
    ).toBe("https://scratch.example.test/api/v1/catalog");
  });

  it("uses the named profile over the default", () => {
    const resolved = resolveCloudCredential(settings, {
      profile: "acme",
      source: "cloud.profile",
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
      resolveCloudCredential({ catalogEndpoint: CATALOG, profiles: {} }, { source: "none" }),
    ).toBeUndefined();
  });
});
