import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

async function expectNoLockFile(homeDir: string): Promise<void> {
  const names = await readdir(join(homeDir, ".ratel"));
  expect(names.filter((name) => name.endsWith(".lock"))).toEqual([]);
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

  it("concurrent update calls keep both profiles", async () => {
    const homeDir = await homeWithRatelDir();
    const target = store(homeDir);
    await Promise.all([
      target.update((current) => ({
        ...current,
        default: current.default ?? "a",
        profiles: { ...current.profiles, a: { apiKey: "rtl_a" } },
      })),
      target.update((current) => ({
        ...current,
        default: current.default ?? "b",
        profiles: { ...current.profiles, b: { apiKey: "rtl_b" } },
      })),
    ]);

    const loaded = await target.load();
    expect(loaded?.profiles).toEqual({ a: { apiKey: "rtl_a" }, b: { apiKey: "rtl_b" } });
    expect(loaded?.default === "a" || loaded?.default === "b").toBe(true);
    expect((await stat(cloudSettingsPath(homeDir))).mode & 0o777).toBe(0o600);
    expect((await stat(join(homeDir, ".ratel"))).mode & 0o777).toBe(0o700);
    await expectNoLockFile(homeDir);
  });

  it("update serializes overlapping mutators on the same file", async () => {
    const homeDir = await homeWithRatelDir();
    const target = store(homeDir);
    const events: string[] = [];
    const holdA = deferred();
    const aStarted = deferred();

    const a = target.update(async (current) => {
      events.push("a:start");
      aStarted.resolve();
      await holdA.promise;
      events.push("a:end");
      return {
        ...current,
        default: current.default ?? "a",
        profiles: { ...current.profiles, a: { apiKey: "rtl_a" } },
      };
    });
    await aStarted.promise;
    const b = target.update(async (current) => {
      events.push("b:start");
      events.push("b:end");
      return {
        ...current,
        default: current.default ?? "b",
        profiles: { ...current.profiles, b: { apiKey: "rtl_b" } },
      };
    });
    holdA.resolve();
    await Promise.all([a, b]);

    expect(events.indexOf("b:start")).toBeGreaterThan(events.indexOf("a:end"));
    expect(await target.load()).toMatchObject({
      profiles: { a: { apiKey: "rtl_a" }, b: { apiKey: "rtl_b" } },
    });
    await expectNoLockFile(homeDir);
  });

  it("update releases the lock when the mutator throws", async () => {
    const homeDir = await homeWithRatelDir();
    const target = store(homeDir);
    await expect(
      target.update(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expectNoLockFile(homeDir);

    await target.update((current) => ({
      ...current,
      default: "ok",
      profiles: { ...current.profiles, ok: { apiKey: "rtl_ok" } },
    }));
    expect(await target.load()).toEqual({
      default: "ok",
      profiles: { ok: { apiKey: "rtl_ok" } },
    });
  });

  it("update rejects malformed settings and leaves no lock file", async () => {
    const homeDir = await homeWithRatelDir();
    await writeFile(cloudSettingsPath(homeDir), "{not json", { encoding: "utf8", mode: 0o600 });
    await expect(
      store(homeDir).update((current) => ({
        ...current,
        profiles: { ...current.profiles, a: { apiKey: "rtl_a" } },
      })),
    ).rejects.toThrow(/not valid JSON/);
    await expectNoLockFile(homeDir);
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
