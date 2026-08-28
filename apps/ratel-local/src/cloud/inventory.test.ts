import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeFs, ratelConfigPath } from "@ratel-ai/ratel-local-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventoryCloudSettings } from "./inventory.js";

const STORE = {
  tracesEndpoint: "https://cloud.ratel.sh/api/v1/traces",
  default: "personal",
  profiles: { personal: { apiKey: "rtl_personal" } },
};

describe("inventoryCloudSettings", () => {
  let homeDir: string;
  let projectRoot: string;

  const codes = async () =>
    (await inventoryCloudSettings({ env: { homeDir, projectRoot }, fs: nodeFs })).map(
      ({ code }) => code,
    );
  const writeStore = (value: unknown) =>
    writeFile(join(homeDir, ".ratel", "cloud.json"), JSON.stringify(value), { mode: 0o600 });
  const selectProfile = (profile: string) =>
    writeFile(
      ratelConfigPath("project", { homeDir, projectRoot }),
      JSON.stringify({ cloud: { profile } }),
    );

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "ratel-inventory-"));
    projectRoot = await mkdtemp(join(tmpdir(), "ratel-project-"));
    await mkdir(join(homeDir, ".ratel"), { recursive: true, mode: 0o700 });
    await mkdir(join(projectRoot, ".ratel"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("says nothing about a healthy store", async () => {
    await writeStore(STORE);
    expect(await codes()).toEqual([]);
  });

  it("says nothing when no Cloud credential is configured at all", async () => {
    expect(await codes()).toEqual([]);
  });

  it("reports a store it cannot parse", async () => {
    await writeStore({ profiles: "not a map" });
    expect(await codes()).toContain("cloud_settings_unreadable");
  });

  it("reports a stored key other users can read", async () => {
    await writeStore(STORE);
    await chmod(join(homeDir, ".ratel", "cloud.json"), 0o644);

    const diagnostics = await inventoryCloudSettings({ env: { homeDir, projectRoot }, fs: nodeFs });

    const exposed = diagnostics.find(({ code }) => code === "cloud_settings_permissions");
    expect(exposed?.severity).toBe("error");
    expect(exposed?.message).toContain("644");
    expect(exposed?.action).toContain("chmod 600");
  });

  it("reports the legacy store left beside the new one", async () => {
    await writeStore(STORE);
    await writeFile(
      join(homeDir, ".ratel", "cloud-traces.json"),
      JSON.stringify({ endpoint: STORE.tracesEndpoint, apiKey: "rtl_legacy" }),
      { mode: 0o600 },
    );

    const diagnostics = await inventoryCloudSettings({ env: { homeDir, projectRoot }, fs: nodeFs });

    const stale = diagnostics.find(({ code }) => code === "cloud_settings_legacy_present");
    expect(stale?.severity).toBe("warning");
    expect(stale?.message).toContain("still holds an API key");
  });

  it("reports a scope selecting a profile the store does not define", async () => {
    await writeStore(STORE);
    await selectProfile("acme");

    const diagnostics = await inventoryCloudSettings({ env: { homeDir, projectRoot }, fs: nodeFs });

    const unresolved = diagnostics.find(({ code }) => code === "cloud_profile_unresolved");
    expect(unresolved?.severity).toBe("error");
    expect(unresolved?.message).toContain('selects Cloud profile "acme"');
    expect(unresolved?.message).toContain("stored profiles: personal");
  });

  it("reports a selected profile when nothing is stored", async () => {
    await selectProfile("acme");
    expect(await codes()).toContain("cloud_profile_unresolved");
  });

  it("accepts a scope selecting a stored profile", async () => {
    await writeStore(STORE);
    await selectProfile("personal");
    expect(await codes()).toEqual([]);
  });

  it("reports a config it cannot read without failing the rest", async () => {
    await writeStore(STORE);
    await writeFile(ratelConfigPath("project", { homeDir, projectRoot }), "{ not json");

    const diagnostics = await inventoryCloudSettings({ env: { homeDir, projectRoot }, fs: nodeFs });

    expect(diagnostics.map(({ code }) => code)).toEqual(["cloud_config_unreadable"]);
    expect(diagnostics[0]?.severity).toBe("warning");
  });
});
