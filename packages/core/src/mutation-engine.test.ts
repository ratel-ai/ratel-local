import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMutationEngine,
  describeRecoveredTransaction,
  documentRevision,
  MutationConflictError,
  type MutationJournalV1,
  type MutationRecoveryResult,
} from "./mutation-engine.js";

describe("MutationEngine", () => {
  let root: string;
  let controlDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ratel-mutation-engine-"));
    controlDir = join(root, "control");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("previews and commits byte replacements while preserving unrelated bytes", async () => {
    const configPath = join(root, "config.json");
    const original = Buffer.from('{"unknown":{"keep":true},"mcpServers":{}}\n');
    const replacement = Buffer.from(
      '{"unknown":{"keep":true},"mcpServers":{"github":{"url":"https://example.test"}}}\n',
    );
    await writeFile(configPath, original);
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "replace-file", path: configPath, contents: replacement },
    ]);

    expect(plan).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      digest: expect.stringMatching(/^plan_[A-Za-z0-9_-]{43}$/),
      baseRevisions: { [configPath]: documentRevision(original) },
      operations: [
        {
          kind: "replace-file",
          path: configPath,
          contentsBase64: replacement.toString("base64"),
        },
      ],
      preview: {
        files: [
          {
            path: configPath,
            existedBefore: true,
            beforeRevision: documentRevision(original),
            afterRevision: documentRevision(replacement),
          },
        ],
      },
    });

    const commit = await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(configPath)).toEqual(replacement);
    expect(commit).toEqual({
      transactionId: plan.id,
      changedPaths: [configPath],
      revisions: { [configPath]: documentRevision(replacement) },
    });
    await expect(
      readFile(join(controlDir, "transactions", `${plan.id}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps control journals, stages, and new files private under a 022 umask", async () => {
    const target = join(root, "project", ".ratel", "config.local.json");
    let inspected = false;
    const previousUmask = process.umask(0o022);
    try {
      const engine = await createMutationEngine({
        controlDir,
        idFactory: () => "private-modes",
        hooks: {
          async beforeApplyOperation() {
            inspected = true;
            const stage = `${target}.ratel-stage-private-modes-0`;
            const journal = join(controlDir, "transactions", "private-modes.json");
            expect((await stat(controlDir)).mode & 0o777).toBe(0o700);
            expect((await stat(join(controlDir, "transactions"))).mode & 0o777).toBe(0o700);
            expect((await stat(stage)).mode & 0o777).toBe(0o600);
            expect((await stat(journal)).mode & 0o777).toBe(0o600);
          },
        },
      });
      const plan = await engine.prepare([
        { kind: "replace-file", path: target, contents: '{"clientSecret":"secret"}\n' },
      ]);
      await engine.commit(plan, { digest: plan.digest });
    } finally {
      process.umask(previousUmask);
    }

    expect(inspected).toBe(true);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("rejects a stale preview with a typed 409 conflict", async () => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, "before");
    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "replace-file", path: configPath, contents: "planned" },
    ]);
    await writeFile(configPath, "manual edit");

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toMatchObject({
      name: "MutationConflictError",
      statusCode: 409,
      reason: "revision_conflict",
      path: configPath,
    });
    expect(await readFile(configPath, "utf8")).toBe("manual edit");
  });

  it("revalidates after staging and preserves an edit made immediately before rename", async () => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, "before");
    const engine = await createMutationEngine({
      controlDir,
      hooks: {
        async beforeApplyOperation() {
          await writeFile(configPath, "manual edit during staging");
        },
      },
    });
    const plan = await engine.prepare([
      { kind: "replace-file", path: configPath, contents: "planned" },
    ]);

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      reason: "revision_conflict",
      path: configPath,
    });
    expect(await readFile(configPath, "utf8")).toBe("manual edit during staging");
  });

  it("requires the exact preview digest", async () => {
    const configPath = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "replace-file", path: configPath, contents: "planned" },
    ]);

    const error = await engine
      .commit(plan, { digest: "plan_wrong" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MutationConflictError);
    expect(error).toMatchObject({ statusCode: 409, reason: "digest_mismatch" });
  });

  it("serializes concurrent applies so exactly one commits", async () => {
    const configPath = join(root, "config.json");
    await writeFile(configPath, "before");
    const firstEngine = await createMutationEngine({ controlDir });
    const secondEngine = await createMutationEngine({ controlDir });
    const plan = await firstEngine.prepare([
      { kind: "replace-file", path: configPath, contents: "after" },
    ]);

    const results = await Promise.allSettled([
      firstEngine.commit(plan, { digest: plan.digest }),
      secondEngine.commit(plan, { digest: plan.digest }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { statusCode: 409, reason: "revision_conflict" },
    });
    expect(await readFile(configPath, "utf8")).toBe("after");
  });

  it("rolls back earlier artifacts after an intermediate failure", async () => {
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "nested", "second.json");
    await mkdir(dirname(secondPath), { recursive: true });
    await writeFile(firstPath, "first-before");
    await writeFile(secondPath, "second-before");
    const engine = await createMutationEngine({
      controlDir,
      hooks: {
        beforeApplyOperation(_operation, index) {
          if (index === 1) throw new Error("injected failure");
        },
      },
    });
    const plan = await engine.prepare([
      { kind: "replace-file", path: firstPath, contents: "first-after" },
      { kind: "replace-file", path: secondPath, contents: "second-after" },
    ]);

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toThrow("injected failure");

    expect(await readFile(firstPath, "utf8")).toBe("first-before");
    expect(await readFile(secondPath, "utf8")).toBe("second-before");
    await expect(
      readFile(join(controlDir, "transactions", `${plan.id}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a second operation on a skill another transaction is changing", async () => {
    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "replace-file", path: join(root, "config.json"), contents: "planned" },
    ]);
    await writeInFlightJournal(["alpha"]);
    const release = await lockfile.lock(controlDir, {
      realpath: false,
      lockfilePath: join(controlDir, "mutation.lock"),
    });

    try {
      await expect(
        engine.commit(plan, { digest: plan.digest, skillIds: ["alpha", "beta"] }),
      ).rejects.toMatchObject({
        reason: "skill_busy",
        message: "skill alpha is already being changed by transaction in-flight",
      });
    } finally {
      await release();
    }
  });

  it("queues rather than rejects when the in-flight transaction holds other skills", async () => {
    const target = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "replace-file", path: target, contents: "planned" },
    ]);
    await writeInFlightJournal(["alpha"]);
    const release = await lockfile.lock(controlDir, {
      realpath: false,
      lockfilePath: join(controlDir, "mutation.lock"),
    });

    const committing = engine.commit(plan, { digest: plan.digest, skillIds: ["beta"] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await release();
    await committing;

    expect(await readFile(target, "utf8")).toBe("planned");
  });

  it("treats an orphaned journal as a crash to recover, not as an operation in flight", async () => {
    const target = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "replace-file", path: target, contents: "planned" },
    ]);
    await writeInFlightJournal(["alpha"]);

    await engine.commit(plan, { digest: plan.digest, skillIds: ["alpha"] });

    expect(await readFile(target, "utf8")).toBe("planned");
  });

  it("records the skills a transaction owns in its journal", async () => {
    let journal: MutationJournalV1 | undefined;
    const engine = await createMutationEngine({
      controlDir,
      idFactory: () => "owned",
      hooks: {
        beforeApplyOperation: async () => {
          const text = await readFile(join(controlDir, "transactions", "owned.json"), "utf8");
          journal = JSON.parse(text) as MutationJournalV1;
        },
      },
    });
    const plan = await engine.prepare([
      { kind: "replace-file", path: join(root, "config.json"), contents: "planned" },
    ]);

    await engine.commit(plan, { digest: plan.digest, skillIds: ["alpha"] });

    expect(journal?.skillIds).toEqual(["alpha"]);
  });

  it("recovers an incomplete journal when a new engine starts", async () => {
    const targetPath = join(root, "config.json");
    const stagePath = `${targetPath}.ratel-stage-crashed-0`;
    const backupPath = `${targetPath}.ratel-backup-crashed-0`;
    await writeFile(targetPath, "partially-applied");
    await writeFile(backupPath, "before");
    await mkdir(join(controlDir, "transactions"), { recursive: true });
    const journal: MutationJournalV1 = {
      version: 1,
      transactionId: "crashed",
      status: "applying",
      kind: "skill.import",
      snapshotId: "2026-05-03T12-00-00.000Z-abcd1234",
      entries: [
        {
          path: targetPath,
          stagePath,
          backupPath,
          existedBefore: true,
          applied: false,
        },
      ],
    };
    await writeFile(
      join(controlDir, "transactions", "crashed.json"),
      `${JSON.stringify(journal)}\n`,
    );

    const recoveries: MutationRecoveryResult[] = [];
    await createMutationEngine({ controlDir, onRecovery: (r) => void recoveries.push(r) });

    expect(recoveries).toEqual([
      {
        recovered: [
          {
            kind: "skill.import",
            snapshotId: "2026-05-03T12-00-00.000Z-abcd1234",
            transactionId: "crashed",
            paths: [targetPath],
          },
        ],
        finalized: [],
      },
    ]);
    expect(await readFile(targetPath, "utf8")).toBe("before");
    await expect(readFile(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(controlDir, "transactions", "crashed.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers on construction even when onRecovery is omitted", async () => {
    const targetPath = join(root, "config.json");
    const stagePath = `${targetPath}.ratel-stage-silent-0`;
    const backupPath = `${targetPath}.ratel-backup-silent-0`;
    await writeFile(targetPath, "partially-applied");
    await writeFile(backupPath, "before");
    await mkdir(join(controlDir, "transactions"), { recursive: true });
    const journal: MutationJournalV1 = {
      version: 1,
      transactionId: "silent",
      status: "applying",
      kind: "skill.import",
      entries: [
        {
          path: targetPath,
          stagePath,
          backupPath,
          existedBefore: true,
          applied: false,
        },
      ],
    };
    await writeFile(
      join(controlDir, "transactions", "silent.json"),
      `${JSON.stringify(journal)}\n`,
    );

    await createMutationEngine({ controlDir });

    expect(await readFile(targetPath, "utf8")).toBe("before");
    await expect(lstat(stagePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(controlDir, "transactions", "silent.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  async function writeInFlightJournal(skillIds: string[]): Promise<void> {
    const journal: MutationJournalV1 = {
      version: 1,
      transactionId: "in-flight",
      status: "applying",
      skillIds,
      entries: [],
    };
    await mkdir(join(controlDir, "transactions"), { recursive: true });
    await writeFile(
      join(controlDir, "transactions", "in-flight.json"),
      `${JSON.stringify(journal)}\n`,
    );
  }

  it("copies a validated directory and config file in one recoverable transaction", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    const config = join(root, "project", ".ratel", "config.json");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill body");
    await writeFile(join(source, "references", "guide.md"), "guide");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      {
        kind: "copy-directory",
        sourcePath: source,
        path: target,
        additionalFiles: [
          {
            relativePath: ".ratel-skill.json",
            contents: JSON.stringify({ version: 1, id: "audit" }),
          },
        ],
      },
      { kind: "replace-file", path: config, contents: '{"skills":{}}\n' },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("skill body");
    expect(JSON.parse(await readFile(join(target, ".ratel-skill.json"), "utf8"))).toEqual({
      version: 1,
      id: "audit",
    });
    expect(await readFile(config, "utf8")).toBe('{"skills":{}}\n');
  });

  it("writes through a symlinked parent directory", async () => {
    const real = join(root, "real-config");
    const linked = join(root, "linked-config");
    await mkdir(real);
    await writeFile(join(real, "config.json"), "before");
    await symlink(real, linked, "dir");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "replace-file", path: join(linked, "config.json"), contents: "after" },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(join(real, "config.json"), "utf8")).toBe("after");
  });

  it("refuses directory merges and unsafe copy sources", async () => {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, "SKILL.md"), "body");
    const engine = await createMutationEngine({ controlDir });

    await expect(
      engine.prepare([{ kind: "copy-directory", sourcePath: source, path: target }]),
    ).rejects.toMatchObject({ statusCode: 422 });

    await rm(target, { recursive: true });
    await symlink(join(root, "outside"), join(source, "escape"));
    await expect(
      engine.prepare([{ kind: "copy-directory", sourcePath: source, path: target }]),
    ).rejects.toThrow(/symlink/i);
  });

  it("deletes an owned directory as a recoverable transaction artifact", async () => {
    const target = join(root, "project", ".ratel", "skills", "audit");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "body");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([{ kind: "delete-artifact", path: target }]);
    expect(plan.preview.files).toEqual([
      expect.objectContaining({
        kind: "directory",
        path: target,
        existedBefore: true,
        afterRevision: "missing",
      }),
    ]);
    await engine.commit(plan, { digest: plan.digest });

    await expect(readFile(join(target, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes only an explicitly validated symlink target", async () => {
    const target = join(root, "native-skill");
    const link = join(root, "managed-skill");
    const other = join(root, "other-skill");
    await mkdir(target);
    await mkdir(other);
    await symlink(target, link);
    const engine = await createMutationEngine({ controlDir });

    await expect(engine.prepare([{ kind: "delete-artifact", path: link }])).rejects.toThrow(
      /must not be a symlink/,
    );
    await expect(
      engine.prepare([
        {
          kind: "delete-artifact",
          path: link,
          expectedSymlinkTarget: await realpath(other),
        },
      ]),
    ).rejects.toThrow(/symlink target mismatch/);

    const plan = await engine.prepare([
      {
        kind: "delete-artifact",
        path: link,
        expectedSymlinkTarget: await realpath(target),
      },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it("restores a deleted directory when a later hook fails", async () => {
    const config = join(root, "config.json");
    const target = join(root, "skill");
    await writeFile(config, "before");
    await mkdir(target);
    await writeFile(join(target, "SKILL.md"), "body");
    const engine = await createMutationEngine({
      controlDir,
      hooks: {
        afterApplyOperation(_operation, index) {
          if (index === 1) throw new Error("delete follow-up failed");
        },
      },
    });
    const plan = await engine.prepare([
      { kind: "replace-file", path: config, contents: "after" },
      { kind: "delete-artifact", path: target },
    ]);

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toThrow(
      "delete follow-up failed",
    );
    expect(await readFile(config, "utf8")).toBe("before");
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("body");
  });

  it("copies a directory before an in-source replace and keeps pre-replace bytes", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "before policy");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "copy-directory", sourcePath: source, path: target },
      {
        kind: "replace-file",
        path: join(source, "SKILL.md"),
        contents: "after policy",
      },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("before policy");
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe("after policy");
    const copiedNames = await readdir(target);
    expect(copiedNames.some((name) => name.includes(".ratel-stage-"))).toBe(false);
    expect(copiedNames.some((name) => name.includes(".ratel-backup-"))).toBe(false);
  });

  it("copies before a replace whose parent directory staging must create", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    const policyPath = join(source, "agents", "openai.yaml");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill body");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "copy-directory", sourcePath: source, path: target },
      { kind: "replace-file", path: policyPath, contents: "policy: true\n" },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("skill body");
    await expect(readdir(join(target, "agents"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(target, "agents", "openai.yaml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(policyPath, "utf8")).toBe("policy: true\n");
    expect((await readdir(join(source, "agents"))).sort()).toEqual(["openai.yaml"]);
  });

  it("rejects a write inside a copy source when ordered before the copy", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "body");
    const engine = await createMutationEngine({ controlDir });

    await expect(
      engine.prepare([
        {
          kind: "replace-file",
          path: join(source, "SKILL.md"),
          contents: "after",
        },
        { kind: "copy-directory", sourcePath: source, path: target },
      ]),
    ).rejects.toMatchObject({
      name: "MutationValidationError",
      message: expect.stringContaining(join(source, "SKILL.md")),
    });
  });

  it("copies a source file whose name contains .ratel-stage- and detects later changes", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    const decoy = join(source, "notes.ratel-stage-fake.md");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "body");
    await writeFile(decoy, "keep me");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "copy-directory", sourcePath: source, path: target },
    ]);
    await writeFile(decoy, "changed after prepare");

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/copy source changed/),
    });
  });

  it("fails when an unrelated file is added to the copy source between prepare and commit", async () => {
    const source = join(root, "native-skill");
    const target = join(root, "project", ".ratel", "skills", "audit");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "body");
    const engine = await createMutationEngine({ controlDir });

    const plan = await engine.prepare([
      { kind: "copy-directory", sourcePath: source, path: target },
    ]);
    await writeFile(join(source, "extra.txt"), "new");

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/copy source changed/),
    });
  });

  it("excludes in-source artifacts when the write path goes through a symlinked ancestor", async () => {
    const realHome = join(root, "real-home");
    const linkedHome = join(root, "linked-home");
    await mkdir(join(realHome, ".agents", "skills", "audit"), { recursive: true });
    await writeFile(join(realHome, ".agents", "skills", "audit", "SKILL.md"), "before policy");
    await symlink(realHome, linkedHome);

    const source = await realpath(join(linkedHome, ".agents", "skills", "audit"));
    const policyPath = join(linkedHome, ".agents", "skills", "audit", "SKILL.md");
    const target = join(root, "project", ".ratel", "skills", "audit");
    expect(source).not.toBe(dirname(policyPath));

    const engine = await createMutationEngine({ controlDir });
    const plan = await engine.prepare([
      { kind: "copy-directory", sourcePath: source, path: target },
      { kind: "replace-file", path: policyPath, contents: "after policy" },
    ]);
    await engine.commit(plan, { digest: plan.digest });

    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("before policy");
    expect(await readFile(policyPath, "utf8")).toBe("after policy");
  });

  it("rolls back a failed commit that created a parent directory without leaving a journal", async () => {
    const target = join(root, "native-skill", "agents", "openai.yaml");
    const createdDir = dirname(target);
    const engine = await createMutationEngine({
      controlDir,
      hooks: {
        beforeApplyOperation() {
          throw new Error("publish blocked");
        },
      },
    });

    const plan = await engine.prepare([
      { kind: "replace-file", path: target, contents: "policy: true\n" },
    ]);

    await expect(engine.commit(plan, { digest: plan.digest })).rejects.toThrow("publish blocked");
    await expect(lstat(createdDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(controlDir, "transactions"))).resolves.toEqual([]);

    const recovered: MutationRecoveryResult[] = [];
    await createMutationEngine({
      controlDir,
      onRecovery: (result) => void recovered.push(result),
    });
    expect(recovered).toEqual([{ recovered: [], finalized: [] }]);
  });

  it("formats recovered snapshot ids in parentheses", () => {
    expect(
      describeRecoveredTransaction({
        kind: "skill.import",
        transactionId: "tx-1",
        paths: ["/a", "/b"],
        snapshotId: "snap-1",
      }),
    ).toBe("rolled back skill.import tx-1: /a, /b (snapshot snap-1)");
  });
});
