import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectId } from "./context.js";
import { inventoryLegacyOAuthStores, migrateLegacyOAuthStores } from "./oauth-legacy-migration.js";
import { resolveMcpEntries } from "./resolved-mcp.js";

describe("legacy OAuth store migration", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "ratel-oauth-migration-"));
    await mkdir(join(homeDir, ".ratel", "oauth"), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it("moves a uniquely mapped legacy store to its scoped key without changing bytes", async () => {
    const legacyPath = join(homeDir, ".ratel", "oauth", "linear.json");
    const payload = '{"tokens":{"access_token":"secret","token_type":"Bearer"}}\n';
    await writeFile(legacyPath, payload, { mode: 0o600 });
    const entries = userEntries(homeDir, "linear", "https://linear.example/mcp");
    const targetPath = entries[0]?.oauthKey.path;
    expect(targetPath).toBeDefined();

    const inventory = await inventoryLegacyOAuthStores({ homeDir, entries });
    expect(inventory.ready).toEqual([
      expect.objectContaining({ serverName: "linear", legacyPath, target: entries[0]?.oauthKey }),
    ]);
    expect(inventory.diagnostics).toEqual([]);

    const report = await migrateLegacyOAuthStores({ homeDir, entries });

    expect(report.migrated).toEqual([
      expect.objectContaining({ serverName: "linear", target: entries[0]?.oauthKey }),
    ]);
    await expect(access(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(targetPath as string, "utf8")).toBe(payload);
    expect((await stat(targetPath as string)).mode & 0o777).toBe(0o600);
  });

  it("deduplicates an inherited user target observed in multiple project snapshots", async () => {
    await putLegacy(homeDir, "shared", {});
    const entries = [
      ...userEntries(homeDir, "shared", "https://shared.example/mcp"),
      ...userEntries(homeDir, "shared", "https://shared.example/mcp"),
    ];

    const inventory = await inventoryLegacyOAuthStores({ homeDir, entries });

    expect(inventory.ready).toHaveLength(1);
    expect(inventory.ready[0]?.target.path).toBe(entries[0]?.oauthKey.path);
    expect(inventory.diagnostics).toEqual([]);
  });

  it("does not guess between same-name user and project owners", async () => {
    const legacyPath = await putLegacy(homeDir, "linear", {});
    const projectId = "prj_a" as ProjectId;
    const entries = resolveMcpEntries({
      homeDir,
      projectRoot: "/workspace/a",
      documents: [
        {
          ref: { scope: "user" },
          config: {
            mcpServers: { linear: { type: "http", url: "https://user.example/mcp" } },
          },
        },
        {
          ref: { scope: "project", projectId },
          config: {
            mcpServers: { linear: { type: "http", url: "https://project.example/mcp" } },
          },
        },
      ],
    });

    const report = await migrateLegacyOAuthStores({ homeDir, entries });

    expect(report.migrated).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy_oauth_ambiguous",
        serverName: "linear",
        legacyPath,
        requiresReauthentication: true,
        targets: expect.arrayContaining(entries.map((entry) => entry.oauthKey)),
      }),
    ]);
    expect(await readFile(legacyPath, "utf8")).toBe("{}\n");
    for (const entry of entries) {
      await expect(access(entry.oauthKey.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("reports stale stores and leaves them in place", async () => {
    const legacyPath = await putLegacy(homeDir, "removed-server", {});

    const report = await migrateLegacyOAuthStores({ homeDir, entries: [] });

    expect(report.migrated).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy_oauth_stale",
        serverName: "removed-server",
        legacyPath,
        requiresReauthentication: true,
      }),
    ]);
    expect(await readFile(legacyPath, "utf8")).toBe("{}\n");
  });

  it("requires re-authentication instead of moving a mismatched fingerprint", async () => {
    const legacyPath = await putLegacy(homeDir, "remote", {
      resource_fingerprint: "different-resource",
      tokens: { access_token: "secret", token_type: "Bearer" },
    });
    const entries = userEntries(homeDir, "remote", "https://current.example/mcp");

    const report = await migrateLegacyOAuthStores({ homeDir, entries });

    expect(report.migrated).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy_oauth_fingerprint_mismatch",
        expectedFingerprint: entries[0]?.oauthKey.fingerprint,
        actualFingerprint: "different-resource",
        requiresReauthentication: true,
      }),
    ]);
    expect(await readFile(legacyPath, "utf8")).toContain("secret");
    await expect(access(entries[0]?.oauthKey.path as string)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("never overwrites a scoped destination and preserves the legacy file", async () => {
    const legacyPath = await putLegacy(homeDir, "remote", { state: "legacy" });
    const entries = userEntries(homeDir, "remote", "https://current.example/mcp");
    const destination = entries[0]?.oauthKey.path as string;
    await mkdir(join(homeDir, ".ratel", "oauth", "user"), { recursive: true });
    await writeFile(destination, '{"state":"current"}\n');

    const report = await migrateLegacyOAuthStores({ homeDir, entries });

    expect(report.migrated).toEqual([]);
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy_oauth_destination_exists",
        requiresReauthentication: false,
      }),
    ]);
    expect(await readFile(destination, "utf8")).toBe('{"state":"current"}\n');
    expect(await readFile(legacyPath, "utf8")).toBe('{"state":"legacy"}\n');
  });

  it("reports malformed legacy state and preserves it", async () => {
    const legacyPath = join(homeDir, ".ratel", "oauth", "broken.json");
    await writeFile(legacyPath, "not json\n");

    const report = await migrateLegacyOAuthStores({
      homeDir,
      entries: userEntries(homeDir, "broken", "https://broken.example/mcp"),
    });

    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        code: "legacy_oauth_invalid",
        requiresReauthentication: true,
      }),
    ]);
    expect(await readFile(legacyPath, "utf8")).toBe("not json\n");
  });
});

function userEntries(homeDir: string, name: string, url: string) {
  return resolveMcpEntries({
    homeDir,
    documents: [
      {
        ref: { scope: "user" },
        config: { mcpServers: { [name]: { type: "http", url } } },
      },
    ],
  });
}

async function putLegacy(
  homeDir: string,
  name: string,
  state: Record<string, unknown>,
): Promise<string> {
  const path = join(homeDir, ".ratel", "oauth", `${name}.json`);
  await writeFile(path, `${JSON.stringify(state)}\n`);
  return path;
}
