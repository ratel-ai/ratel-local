import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMutationEngine,
  documentRevision,
  MutationConflictError,
  type MutationJournalV1,
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

    await createMutationEngine({ controlDir });

    expect(await readFile(targetPath, "utf8")).toBe("before");
    await expect(readFile(backupPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(controlDir, "transactions", "crashed.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

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
});
