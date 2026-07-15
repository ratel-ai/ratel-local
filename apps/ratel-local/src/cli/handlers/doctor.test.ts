import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectRegistry, type MutationJournalV1, nodeFs } from "@ratel-ai/ratel-local-core";
import { afterEach, describe, expect, it } from "vitest";
import { silentPromptAdapter } from "../prompts.js";
import { DoctorFailure, runDoctor } from "./doctor.js";
import type { HandlerCtx } from "./types.js";

describe("runDoctor", () => {
  const homes: string[] = [];

  afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("recovers transactions and validates a healthy global context", async () => {
    const homeDir = await temporaryHome();
    const logs: string[] = [];

    await runDoctor(context(homeDir, logs));

    expect(logs).toContain("[ok] mutation_recovery: transaction recovery completed");
    expect(logs).toContain("[ok] context_global: resolved global context");
    expect(logs.at(-1)).toBe("doctor: ok (1 context checked)");
  });

  it("recovers an incomplete mutation before reading configuration snapshots", async () => {
    const homeDir = await temporaryHome();
    const controlDir = join(homeDir, ".ratel");
    const configPath = join(controlDir, "config.json");
    const transactionId = "doctor-crash";
    const stagePath = `${configPath}.ratel-stage-${transactionId}-0`;
    const backupPath = `${configPath}.ratel-backup-${transactionId}-0`;
    const transactionsDir = join(controlDir, "transactions");
    await mkdir(transactionsDir, { recursive: true });
    await writeFile(configPath, "{partially-applied\n");
    await writeFile(backupPath, '{"mcpServers":{}}\n');
    const journal: MutationJournalV1 = {
      version: 1,
      transactionId,
      status: "applying",
      entries: [
        {
          artifactKind: "file",
          operationKind: "replace-file",
          path: configPath,
          stagePath,
          backupPath,
          existedBefore: true,
          applied: false,
        },
      ],
    };
    await writeFile(join(transactionsDir, `${transactionId}.json`), `${JSON.stringify(journal)}\n`);
    const logs: string[] = [];

    await runDoctor(context(homeDir, logs));

    expect(await readFile(configPath, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(logs).toContain("[ok] context_global: resolved global context");
  });

  it("reports a stable failure when transaction recovery cannot complete", async () => {
    const homeDir = await temporaryHome();
    const transactionsDir = join(homeDir, ".ratel", "transactions");
    await mkdir(transactionsDir, { recursive: true });
    await writeFile(join(transactionsDir, "broken.json"), "not-json\n");
    const logs: string[] = [];

    await expect(runDoctor(context(homeDir, logs))).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toEqual([
      expect.stringMatching(/^\[error] mutation_recovery_failed: .*Action: inspect .*transactions/),
    ]);
  });

  it("resolves every available registered project context", async () => {
    const homeDir = await temporaryHome();
    const projectRoot = join(homeDir, "workspace");
    await mkdir(projectRoot);
    const project = await createProjectRegistry({ homeDir }).registerRoot(projectRoot);
    const logs: string[] = [];

    await runDoctor(context(homeDir, logs));

    expect(logs).toContain(
      `[ok] context_project: resolved project ${project.id} (${project.canonicalRoot})`,
    );
    expect(logs.at(-1)).toBe("doctor: ok (2 contexts checked)");
  });

  it("reports a missing registered project as an actionable failure", async () => {
    const homeDir = await temporaryHome();
    const projectRoot = join(homeDir, "missing-workspace");
    await mkdir(projectRoot);
    const project = await createProjectRegistry({ homeDir }).registerRoot(projectRoot);
    await rm(projectRoot, { recursive: true });
    const logs: string[] = [];

    const result = runDoctor(context(homeDir, logs));

    await expect(result).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toContain(
      `[error] project_missing: project ${project.id} root is unavailable: ${project.canonicalRoot}. Action: restore the root or remove the registration.`,
    );
  });

  it("reports an invalid project registry with an actionable diagnostic", async () => {
    const homeDir = await temporaryHome();
    const projectsPath = join(homeDir, ".ratel", "projects.json");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await writeFile(projectsPath, "{not-json\n");
    const logs: string[] = [];

    await expect(runDoctor(context(homeDir, logs))).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\[error] project_registry_invalid: .*Action: inspect .*projects\.json/,
        ),
      ]),
    );
  });

  it("reports invalid configuration with the resolver diagnostic code", async () => {
    const homeDir = await temporaryHome();
    const configPath = join(homeDir, ".ratel", "config.json");
    await mkdir(join(homeDir, ".ratel"), { recursive: true });
    await writeFile(configPath, "{not-json\n");
    const logs: string[] = [];

    await expect(runDoctor(context(homeDir, logs))).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[error] config-invalid \[global]: .*config\.json:/),
      ]),
    );
  });

  it("reports legacy OAuth diagnostics and required re-authentication", async () => {
    const homeDir = await temporaryHome();
    const oauthDir = join(homeDir, ".ratel", "oauth");
    await mkdir(oauthDir, { recursive: true });
    await writeFile(join(oauthDir, "removed-server.json"), "{}\n");
    const logs: string[] = [];

    await expect(runDoctor(context(homeDir, logs))).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\[warning] legacy_oauth_stale \[oauth:removed-server]: .*Action: re-authenticate "removed-server"/,
        ),
      ]),
    );
  });

  it("reports a stable failure when legacy OAuth inventory cannot be read", async () => {
    const homeDir = await temporaryHome();
    const controlDir = join(homeDir, ".ratel");
    await mkdir(controlDir, { recursive: true });
    await writeFile(join(controlDir, "oauth"), "not-a-directory\n");
    const logs: string[] = [];

    await expect(runDoctor(context(homeDir, logs))).rejects.toMatchObject({
      name: DoctorFailure.name,
      issueCount: 1,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\[error] legacy_oauth_inventory_failed: .*Action: inspect .*\.ratel.*oauth/,
        ),
      ]),
    );
  });

  it("reports an unambiguous legacy OAuth store as ready without modifying it", async () => {
    const homeDir = await temporaryHome();
    const controlDir = join(homeDir, ".ratel");
    const oauthDir = join(controlDir, "oauth");
    const legacyPath = join(oauthDir, "remote.json");
    await mkdir(oauthDir, { recursive: true });
    await writeFile(
      join(controlDir, "config.json"),
      '{"mcpServers":{"remote":{"type":"http","url":"https://example.test/mcp"}}}\n',
    );
    await writeFile(legacyPath, '{"tokens":{"access_token":"secret"}}\n');
    const logs: string[] = [];

    await runDoctor(context(homeDir, logs));

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\[info] legacy_oauth_migration_ready \[oauth:remote]: .*daemon starts/,
        ),
      ]),
    );
    expect(await readFile(legacyPath, "utf8")).toContain("secret");
    expect(logs.at(-1)).toBe("doctor: ok (1 context checked)");
  });

  async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "ratel-doctor-"));
    homes.push(home);
    return home;
  }
});

function context(homeDir: string, logs: string[]): HandlerCtx {
  return {
    argv: { group: "doctor", configPaths: [], rest: [], extras: [], flags: {} },
    env: { homeDir },
    fs: nodeFs,
    log: (message) => logs.push(message),
    prompts: silentPromptAdapter(),
  };
}
