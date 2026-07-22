import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import lockfile from "proper-lockfile";
import type { DocumentRevision } from "./context.js";

export type PreparedMutationDigest = string & { readonly __brand: "PreparedMutationDigest" };

export const MISSING_DOCUMENT_REVISION = "missing" as DocumentRevision;

export interface ReplaceFileInput {
  kind: "replace-file";
  path: string;
  /** Raw replacement bytes. Strings are encoded as UTF-8. */
  contents: string | Uint8Array;
}

export interface AdditionalDirectoryFileInput {
  relativePath: string;
  contents: string | Uint8Array;
}

export interface CopyDirectoryInput {
  kind: "copy-directory";
  sourcePath: string;
  path: string;
  additionalFiles?: AdditionalDirectoryFileInput[];
}

export interface DeleteArtifactInput {
  kind: "delete-artifact";
  path: string;
}

export type MutationInputOperation = ReplaceFileInput | CopyDirectoryInput | DeleteArtifactInput;

/** Private, normalized operation retained only by trusted control-plane code. */
export interface ReplaceFileOperation {
  kind: "replace-file";
  path: string;
  contentsBase64: string;
}

export interface AdditionalDirectoryFile {
  relativePath: string;
  contentsBase64: string;
}

export interface CopyDirectoryOperation {
  kind: "copy-directory";
  sourcePath: string;
  sourceRevision: DocumentRevision;
  path: string;
  additionalFiles: AdditionalDirectoryFile[];
}

export interface DeleteArtifactOperation {
  kind: "delete-artifact";
  path: string;
}

export type MutationOperation =
  | ReplaceFileOperation
  | CopyDirectoryOperation
  | DeleteArtifactOperation;

export interface MutationPreviewFile {
  kind: "file" | "directory";
  path: string;
  existedBefore: boolean;
  beforeRevision: DocumentRevision;
  afterRevision: DocumentRevision;
}

export interface MutationPreview {
  files: MutationPreviewFile[];
}

export interface PreparedMutation {
  id: string;
  digest: PreparedMutationDigest;
  baseRevisions: Record<string, DocumentRevision>;
  operations: MutationOperation[];
  preview: MutationPreview;
}

export interface CommitMutationOptions {
  /** Internal digest of the prepared mutation. */
  digest: string;
  /** Internal control-plane invariant checked while the cross-process lock is held. */
  precondition?: () => void | Promise<void>;
  /** Recheck path/ownership invariants immediately before publishing each artifact. */
  operationPrecondition?: (operation: MutationOperation, index: number) => void | Promise<void>;
}

export interface MutationCommit {
  transactionId: string;
  changedPaths: string[];
  revisions: Record<string, DocumentRevision>;
}

export interface MutationEngineHooks {
  beforeApplyOperation?(operation: MutationOperation, index: number): void | Promise<void>;
  afterApplyOperation?(operation: MutationOperation, index: number): void | Promise<void>;
}

export interface MutationEngineOptions {
  /** Directory containing mutation.lock and the transactions journal directory. */
  controlDir: string;
  hooks?: MutationEngineHooks;
  idFactory?: () => string;
}

export interface MutationRecoveryResult {
  recovered: string[];
  finalized: string[];
}

export interface MutationEngine {
  prepare(operations: readonly MutationInputOperation[]): Promise<PreparedMutation>;
  commit(plan: PreparedMutation, options: CommitMutationOptions): Promise<MutationCommit>;
  recover(): Promise<MutationRecoveryResult>;
}

export type MutationConflictReason =
  | "digest_mismatch"
  | "revision_conflict"
  | "transaction_conflict";

/** Maps directly to HTTP 409 without coupling the core package to an HTTP framework. */
export class MutationConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "MUTATION_CONFLICT";

  constructor(
    readonly reason: MutationConflictReason,
    message: string,
    readonly path?: string,
    readonly expectedRevision?: DocumentRevision,
    readonly actualRevision?: DocumentRevision,
  ) {
    super(message);
    this.name = "MutationConflictError";
  }
}

/** Maps directly to HTTP 422 for an invalid, non-executable plan. */
export class MutationValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "MUTATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MutationValidationError";
  }
}

export class MutationRecoveryError extends Error {
  readonly statusCode = 500;
  readonly code = "MUTATION_RECOVERY_FAILED";

  constructor(
    readonly transactionId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MutationRecoveryError";
  }
}

export interface MutationJournalEntryV1 {
  artifactKind?: "file" | "directory";
  operationKind?: MutationOperation["kind"];
  path: string;
  stagePath: string;
  backupPath: string;
  existedBefore: boolean;
  applied: boolean;
}

/** Exported so doctor/recovery tooling can inspect journals without private schema knowledge. */
export interface MutationJournalV1 {
  version: 1;
  transactionId: string;
  status: "prepared" | "applying" | "committed";
  entries: MutationJournalEntryV1[];
}

const LOCK_OPTIONS = {
  realpath: false,
  stale: 30_000,
  retries: { retries: 200, factor: 1, minTimeout: 10, maxTimeout: 100 },
} as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function documentRevision(bytes: string | Uint8Array): DocumentRevision {
  return `rev_${createHash("sha256").update(bytes).digest("base64url")}` as DocumentRevision;
}

export async function createMutationEngine(
  options: MutationEngineOptions,
): Promise<MutationEngine> {
  const engine = new FilesystemMutationEngine(options);
  await engine.recover();
  return engine;
}

export class FilesystemMutationEngine implements MutationEngine {
  private readonly transactionsDir: string;
  private readonly lockPath: string;
  private readonly hooks: MutationEngineHooks;
  private readonly idFactory: () => string;

  constructor(private readonly options: MutationEngineOptions) {
    this.transactionsDir = join(options.controlDir, "transactions");
    this.lockPath = join(options.controlDir, "mutation.lock");
    this.hooks = options.hooks ?? {};
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async prepare(inputs: readonly MutationInputOperation[]): Promise<PreparedMutation> {
    const paths = new Set<string>();
    const operations: MutationOperation[] = [];
    const baseRevisions: Record<string, DocumentRevision> = {};
    const files: MutationPreviewFile[] = [];

    for (const input of inputs) {
      if (!isAbsolute(input.path) || input.path.includes("\0")) {
        throw new MutationValidationError(`mutation target must be an absolute file path`);
      }
      if (paths.has(input.path)) {
        throw new MutationValidationError(`plan would replace ${input.path} more than once`);
      }
      paths.add(input.path);

      const before = await readArtifact(input.path);
      if (input.kind === "delete-artifact") {
        if (!before.exists || !before.kind) {
          throw new MutationValidationError(`delete target does not exist: ${input.path}`);
        }
        baseRevisions[input.path] = before.revision;
        operations.push({ kind: "delete-artifact", path: input.path });
        files.push({
          kind: before.kind,
          path: input.path,
          existedBefore: true,
          beforeRevision: before.revision,
          afterRevision: MISSING_DOCUMENT_REVISION,
        });
        continue;
      }
      if (input.kind === "replace-file") {
        if (before.exists && before.kind !== "file") {
          throw new MutationValidationError(`file target is not a regular file: ${input.path}`);
        }
        const contents = toBuffer(input.contents);
        const afterRevision = documentRevision(contents);
        baseRevisions[input.path] = before.revision;
        operations.push({
          kind: "replace-file",
          path: input.path,
          contentsBase64: contents.toString("base64"),
        });
        files.push({
          kind: "file",
          path: input.path,
          existedBefore: before.exists,
          beforeRevision: before.revision,
          afterRevision,
        });
        continue;
      }

      if (before.exists) {
        throw new MutationValidationError(
          `copy target already exists; directory merges are not supported: ${input.path}`,
        );
      }
      if (!isAbsolute(input.sourcePath) || input.sourcePath.includes("\0")) {
        throw new MutationValidationError("copy source must be an absolute directory path");
      }
      const sourceRevision = await directoryRevision(input.sourcePath);
      const additionalFiles = await normalizeAdditionalFiles(
        input.sourcePath,
        input.additionalFiles ?? [],
      );
      const afterRevision = copiedDirectoryRevision(sourceRevision, additionalFiles);
      baseRevisions[input.path] = before.revision;
      operations.push({
        kind: "copy-directory",
        sourcePath: input.sourcePath,
        sourceRevision,
        path: input.path,
        additionalFiles,
      });
      files.push({
        kind: "directory",
        path: input.path,
        existedBefore: false,
        beforeRevision: before.revision,
        afterRevision,
      });
    }

    const planWithoutDigest = {
      id: this.idFactory(),
      baseRevisions,
      operations,
      preview: { files },
    };
    return {
      ...planWithoutDigest,
      digest: preparedMutationDigest(planWithoutDigest),
    };
  }

  async commit(plan: PreparedMutation, options: CommitMutationOptions): Promise<MutationCommit> {
    this.validateDigest(plan, options.digest);

    return this.withLock(async () => {
      await this.recoverUnlocked();
      await this.validateBaseRevisions(plan);
      await options.precondition?.();
      return this.commitUnlocked(plan, options);
    });
  }

  async recover(): Promise<MutationRecoveryResult> {
    return this.withLock(() => this.recoverUnlocked());
  }

  private validateDigest(plan: PreparedMutation, suppliedDigest: string): void {
    this.validatePlanShape(plan);
    const { digest: _digest, ...planWithoutDigest } = plan;
    const actualDigest = preparedMutationDigest(planWithoutDigest);
    if (suppliedDigest !== plan.digest || actualDigest !== plan.digest) {
      throw new MutationConflictError(
        "digest_mismatch",
        "mutation preview is stale or does not match the supplied plan digest",
      );
    }
  }

  private validatePlanShape(plan: PreparedMutation): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(plan.id)) {
      throw new MutationValidationError("mutation plan has an unsafe transaction id");
    }
    if (plan.operations.length !== plan.preview.files.length) {
      throw new MutationValidationError("mutation plan operations and preview do not align");
    }

    const seen = new Set<string>();
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      const preview = plan.preview.files[index];
      if (!operation || !preview) {
        throw new MutationValidationError(`invalid mutation operation at index ${index}`);
      }
      if (
        !isAbsolute(operation.path) ||
        operation.path.includes("\0") ||
        seen.has(operation.path)
      ) {
        throw new MutationValidationError(
          `invalid or duplicate mutation target: ${operation.path}`,
        );
      }
      seen.add(operation.path);
      const baseRevision = plan.baseRevisions[operation.path];
      if (baseRevision === undefined) {
        throw new MutationValidationError(`plan has no base revision for ${operation.path}`);
      }
      let expectedAfterRevision: DocumentRevision;
      let expectedKind: MutationPreviewFile["kind"];
      if (operation.kind === "replace-file") {
        const decoded = decodeBase64(operation.contentsBase64, operation.path);
        expectedAfterRevision = documentRevision(decoded);
        expectedKind = "file";
      } else if (operation.kind === "copy-directory") {
        if (!isAbsolute(operation.sourcePath) || operation.sourcePath.includes("\0")) {
          throw new MutationValidationError(`invalid copy source: ${operation.sourcePath}`);
        }
        validateAdditionalFiles(operation.additionalFiles);
        expectedAfterRevision = copiedDirectoryRevision(
          operation.sourceRevision,
          operation.additionalFiles,
        );
        expectedKind = "directory";
        if (baseRevision !== MISSING_DOCUMENT_REVISION || preview.existedBefore) {
          throw new MutationValidationError(`copy target must not exist: ${operation.path}`);
        }
      } else if (operation.kind === "delete-artifact") {
        expectedAfterRevision = MISSING_DOCUMENT_REVISION;
        expectedKind = preview.kind;
        if (
          baseRevision === MISSING_DOCUMENT_REVISION ||
          !preview.existedBefore ||
          (preview.kind !== "file" && preview.kind !== "directory")
        ) {
          throw new MutationValidationError(`delete target must exist: ${operation.path}`);
        }
      } else {
        throw new MutationValidationError(`invalid mutation operation at index ${index}`);
      }
      if (
        preview.kind !== expectedKind ||
        preview.path !== operation.path ||
        preview.beforeRevision !== baseRevision ||
        preview.existedBefore !== (baseRevision !== MISSING_DOCUMENT_REVISION) ||
        preview.afterRevision !== expectedAfterRevision
      ) {
        throw new MutationValidationError(`preview does not match operation ${operation.path}`);
      }
    }
  }

  private async validateBaseRevisions(plan: PreparedMutation): Promise<void> {
    for (const operation of plan.operations) {
      await this.validateOperationBaseRevision(plan, operation);
    }
  }

  private async validateOperationBaseRevision(
    plan: PreparedMutation,
    operation: MutationOperation,
  ): Promise<void> {
    const expected = plan.baseRevisions[operation.path];
    if (expected === undefined) {
      throw new MutationValidationError(`plan has no base revision for ${operation.path}`);
    }
    const actual = (await readArtifact(operation.path)).revision;
    if (actual !== expected) {
      throw new MutationConflictError(
        "revision_conflict",
        `document changed after preview: ${operation.path}`,
        operation.path,
        expected,
        actual,
      );
    }
    if (operation.kind === "copy-directory") {
      const sourceRevision = await directoryRevision(operation.sourcePath);
      if (sourceRevision !== operation.sourceRevision) {
        throw new MutationConflictError(
          "revision_conflict",
          `copy source changed after preview: ${operation.sourcePath}`,
          operation.sourcePath,
          operation.sourceRevision,
          sourceRevision,
        );
      }
    }
  }

  private async commitUnlocked(
    plan: PreparedMutation,
    options: CommitMutationOptions,
  ): Promise<MutationCommit> {
    const journalPath = this.journalPath(plan.id);
    if (await pathExists(journalPath)) {
      throw new MutationConflictError(
        "transaction_conflict",
        `transaction id already exists: ${plan.id}`,
      );
    }

    const journal: MutationJournalV1 = {
      version: 1,
      transactionId: plan.id,
      status: "prepared",
      entries: plan.operations.map((operation, index) => ({
        artifactKind:
          operation.kind === "delete-artifact"
            ? plan.preview.files[index]?.kind
            : operation.kind === "copy-directory"
              ? "directory"
              : "file",
        operationKind: operation.kind,
        path: operation.path,
        stagePath: `${operation.path}.ratel-stage-${plan.id}-${index}`,
        backupPath: `${operation.path}.ratel-backup-${plan.id}-${index}`,
        existedBefore: plan.preview.files[index]?.existedBefore ?? false,
        applied: false,
      })),
    };

    let journalPersisted = false;
    try {
      await this.writeJournal(journal);
      journalPersisted = true;
      await this.prepareArtifacts(plan, journal);
      journal.status = "applying";
      await this.writeJournal(journal);

      for (let index = 0; index < plan.operations.length; index += 1) {
        const operation = plan.operations[index];
        const entry = journal.entries[index];
        if (!operation || !entry) {
          throw new MutationValidationError("operation and journal entry counts differ");
        }
        await this.hooks.beforeApplyOperation?.(operation, index);
        await this.validateOperationBaseRevision(plan, operation);
        await options.operationPrecondition?.(operation, index);
        if (operation.kind === "replace-file" && entry.existedBefore) {
          const sourceStat = await stat(entry.path);
          await copyFile(entry.path, entry.backupPath, 1);
          const backupRevision = (await readArtifact(entry.backupPath)).revision;
          const expectedRevision = plan.baseRevisions[operation.path];
          if (backupRevision !== expectedRevision) {
            throw new MutationConflictError(
              "revision_conflict",
              `document changed while creating backup: ${operation.path}`,
              operation.path,
              expectedRevision,
              backupRevision,
            );
          }
          await this.validateOperationBaseRevision(plan, operation);
          await chmod(entry.stagePath, sourceStat.mode & 0o7777);
        }
        if (operation.kind === "copy-directory" && (await pathExists(operation.path))) {
          throw new MutationConflictError(
            "revision_conflict",
            `copy target appeared during commit: ${operation.path}`,
            operation.path,
            MISSING_DOCUMENT_REVISION,
            (await readArtifact(operation.path)).revision,
          );
        }
        if (operation.kind === "delete-artifact") {
          await rename(entry.path, entry.backupPath);
        } else {
          await rename(entry.stagePath, entry.path);
        }
        entry.applied = true;
        await this.writeJournal(journal);
        await this.hooks.afterApplyOperation?.(operation, index);
      }

      journal.status = "committed";
      await this.writeJournal(journal);
      await this.finalizeJournal(journal, journalPath);
    } catch (error) {
      try {
        if (journalPersisted) {
          await this.rollbackJournal(journal);
          await rm(journalPath, { force: true });
        } else {
          await this.cleanupArtifacts(journal.entries);
        }
      } catch (rollbackError) {
        throw new MutationRecoveryError(plan.id, `failed to roll back transaction ${plan.id}`, {
          cause: { applyError: error, rollbackError },
        });
      }
      throw error;
    }

    const revisions: Record<string, DocumentRevision> = {};
    for (const file of plan.preview.files) revisions[file.path] = file.afterRevision;
    return {
      transactionId: plan.id,
      changedPaths: plan.operations.map(({ path }) => path),
      revisions,
    };
  }

  private async prepareArtifacts(
    plan: PreparedMutation,
    journal: MutationJournalV1,
  ): Promise<void> {
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      const entry = journal.entries[index];
      if (!operation || !entry) {
        throw new MutationValidationError("operation and journal entry counts differ");
      }
      await mkdir(dirname(operation.path), { recursive: true });
      if (operation.kind === "delete-artifact") {
        continue;
      }
      if (operation.kind === "replace-file") {
        await writeFile(entry.stagePath, decodeBase64(operation.contentsBase64, operation.path), {
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
      } else {
        await copyValidatedDirectory(operation.sourcePath, entry.stagePath);
        for (const additional of operation.additionalFiles) {
          const target = join(entry.stagePath, additional.relativePath);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, decodeBase64(additional.contentsBase64, target), {
            flag: "wx",
            mode: PRIVATE_FILE_MODE,
          });
        }
        if ((await directoryRevision(operation.sourcePath)) !== operation.sourceRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `copy source changed while staging: ${operation.sourcePath}`,
            operation.sourcePath,
            operation.sourceRevision,
          );
        }
      }
    }
  }

  private async recoverUnlocked(): Promise<MutationRecoveryResult> {
    await mkdir(this.transactionsDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(this.transactionsDir, PRIVATE_DIRECTORY_MODE);
    const recovered: string[] = [];
    const finalized: string[] = [];
    const names = (await readdir(this.transactionsDir))
      .filter((name) => name.endsWith(".json"))
      .sort();

    for (const name of names) {
      const journalPath = join(this.transactionsDir, name);
      const journal = await readJournal(journalPath);
      try {
        if (journal.status === "committed") {
          await this.finalizeJournal(journal, journalPath);
          finalized.push(journal.transactionId);
        } else {
          await this.rollbackJournal(journal);
          await rm(journalPath, { force: true });
          recovered.push(journal.transactionId);
        }
      } catch (error) {
        throw new MutationRecoveryError(
          journal.transactionId,
          `failed to recover transaction ${journal.transactionId}`,
          { cause: error },
        );
      }
    }
    return { recovered, finalized };
  }

  private async rollbackJournal(journal: MutationJournalV1): Promise<void> {
    for (const entry of [...journal.entries].reverse()) {
      if (entry.operationKind === "delete-artifact") {
        const backupExists = await pathExists(entry.backupPath);
        const targetExists = await pathExists(entry.path);
        const wasApplied = entry.applied || (backupExists && !targetExists);
        if (wasApplied) {
          if (backupExists) {
            await rename(entry.backupPath, entry.path);
          } else if (!targetExists) {
            throw new Error(`missing deleted artifact backup for ${entry.path}`);
          }
        }
        await rm(entry.stagePath, { recursive: true, force: true });
        await rm(entry.backupPath, { recursive: true, force: true });
        continue;
      }
      const stageStillExists = await pathExists(entry.stagePath);
      const wasApplied = entry.applied || !stageStillExists;
      if (wasApplied) {
        if (entry.existedBefore) {
          if (await pathExists(entry.backupPath)) {
            await rename(entry.backupPath, entry.path);
          } else if (!(await pathExists(entry.path))) {
            throw new Error(`missing backup for ${entry.path}`);
          }
        } else {
          await rm(entry.path, { recursive: true, force: true });
        }
      }
      await rm(entry.stagePath, { recursive: true, force: true });
      await rm(entry.backupPath, { recursive: true, force: true });
    }
  }

  private async finalizeJournal(journal: MutationJournalV1, journalPath: string): Promise<void> {
    await this.cleanupArtifacts(journal.entries);
    await rm(journalPath, { force: true });
  }

  private async cleanupArtifacts(entries: readonly MutationJournalEntryV1[]): Promise<void> {
    for (const entry of entries) {
      await rm(entry.stagePath, { recursive: true, force: true });
      await rm(entry.backupPath, { recursive: true, force: true });
    }
  }

  private async writeJournal(journal: MutationJournalV1): Promise<void> {
    await mkdir(this.transactionsDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(this.transactionsDir, PRIVATE_DIRECTORY_MODE);
    const path = this.journalPath(journal.transactionId);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private journalPath(transactionId: string): string {
    return join(this.transactionsDir, `${transactionId}.json`);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.options.controlDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(this.options.controlDir, PRIVATE_DIRECTORY_MODE);
    const release = await lockfile.lock(this.options.controlDir, {
      ...LOCK_OPTIONS,
      lockfilePath: this.lockPath,
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function preparedMutationDigest(plan: Omit<PreparedMutation, "digest">): PreparedMutationDigest {
  const canonical = {
    id: plan.id,
    baseRevisions: Object.fromEntries(
      Object.entries(plan.baseRevisions).sort(([a], [b]) => a.localeCompare(b)),
    ),
    operations: plan.operations,
    preview: plan.preview,
  };
  const digest = createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
  return `plan_${digest}` as PreparedMutationDigest;
}

function toBuffer(contents: string | Uint8Array): Buffer {
  return typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
}

async function readArtifact(
  path: string,
): Promise<{ exists: boolean; kind?: "file" | "directory"; revision: DocumentRevision }> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new MutationValidationError(`mutation target must not be a symlink: ${path}`);
    }
    if (info.isDirectory()) {
      return { exists: true, kind: "directory", revision: await directoryRevision(path) };
    }
    if (!info.isFile()) {
      throw new MutationValidationError(
        `mutation target must be a regular file or directory: ${path}`,
      );
    }
    return { exists: true, kind: "file", revision: documentRevision(await readFile(path)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, revision: MISSING_DOCUMENT_REVISION };
    }
    throw error;
  }
}

async function normalizeAdditionalFiles(
  sourcePath: string,
  inputs: readonly AdditionalDirectoryFileInput[],
): Promise<AdditionalDirectoryFile[]> {
  const files = inputs.map(({ relativePath, contents }) => ({
    relativePath,
    contentsBase64: toBuffer(contents).toString("base64"),
  }));
  validateAdditionalFiles(files);
  for (const file of files) {
    if (await pathExists(join(sourcePath, file.relativePath))) {
      throw new MutationValidationError(
        `additional copy file collides with source content: ${file.relativePath}`,
      );
    }
  }
  return files;
}

function validateAdditionalFiles(files: readonly AdditionalDirectoryFile[]): void {
  const seen = new Set<string>();
  for (const file of files) {
    const normalized = normalize(file.relativePath);
    if (
      !file.relativePath ||
      isAbsolute(file.relativePath) ||
      file.relativePath.includes("\0") ||
      normalized === ".." ||
      normalized.startsWith(`..${sep}`) ||
      seen.has(normalized)
    ) {
      throw new MutationValidationError(`invalid additional copy path: ${file.relativePath}`);
    }
    decodeBase64(file.contentsBase64, file.relativePath);
    seen.add(normalized);
  }
}

function decodeBase64(value: string, path: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new MutationValidationError(`invalid replacement bytes for ${path}`);
  }
  return decoded;
}

function copiedDirectoryRevision(
  sourceRevision: DocumentRevision,
  additionalFiles: readonly AdditionalDirectoryFile[],
): DocumentRevision {
  const hash = createHash("sha256").update("ratel-copy-directory-v1\0").update(sourceRevision);
  for (const file of [...additionalFiles].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    hash.update("\0").update(file.relativePath).update("\0").update(file.contentsBase64);
  }
  return `dir_${hash.digest("base64url")}` as DocumentRevision;
}

async function directoryRevision(path: string): Promise<DocumentRevision> {
  let rootInfo: Stats;
  try {
    rootInfo = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MutationValidationError(`copy source does not exist: ${path}`);
    }
    throw error;
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new MutationValidationError(`copy source must be a real directory: ${path}`);
  }
  const hash = createHash("sha256").update("ratel-directory-v1\0");
  const queue = [""];
  while (queue.length > 0) {
    const relative = queue.shift() as string;
    const entries = (await readdir(join(path, relative), { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const childRelative = relative ? join(relative, entry.name) : entry.name;
      const child = join(path, childRelative);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        throw new MutationValidationError(`copy source contains a symlink: ${child}`);
      }
      if (info.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        queue.push(childRelative);
      } else if (info.isFile()) {
        hash
          .update(`f\0${childRelative}\0`)
          .update(await readFile(child))
          .update("\0");
      } else {
        throw new MutationValidationError(`copy source contains a special file: ${child}`);
      }
    }
  }
  return `dir_${hash.digest("base64url")}` as DocumentRevision;
}

/** Validate a prospective/adopted copy tree and return its complete content revision. */
export function validateCopySourceDirectory(path: string): Promise<DocumentRevision> {
  return directoryRevision(path);
}

async function copyValidatedDirectory(source: string, target: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new MutationValidationError(`copy source must be a real directory: ${source}`);
  }
  await mkdir(target, { mode: sourceInfo.mode & 0o7777 });
  const entries = (await readdir(source, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const sourceChild = join(source, entry.name);
    const targetChild = join(target, entry.name);
    const info = await lstat(sourceChild);
    if (info.isSymbolicLink()) {
      throw new MutationValidationError(`copy source contains a symlink: ${sourceChild}`);
    }
    if (info.isDirectory()) {
      await copyValidatedDirectory(sourceChild, targetChild);
    } else if (info.isFile()) {
      await copyFile(sourceChild, targetChild, 1);
      await chmod(targetChild, info.mode & 0o7777);
    } else {
      throw new MutationValidationError(`copy source contains a special file: ${sourceChild}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJournal(path: string): Promise<MutationJournalV1> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new MutationRecoveryError("unknown", `invalid transaction journal at ${path}`, {
      cause: error,
    });
  }
  if (!isMutationJournal(value)) {
    throw new MutationRecoveryError("unknown", `invalid transaction journal at ${path}`);
  }
  return value;
}

function isMutationJournal(value: unknown): value is MutationJournalV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MutationJournalV1>;
  if (
    candidate.version !== 1 ||
    typeof candidate.transactionId !== "string" ||
    !["prepared", "applying", "committed"].includes(candidate.status ?? "") ||
    !Array.isArray(candidate.entries)
  ) {
    return false;
  }
  return candidate.entries.every((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Partial<MutationJournalEntryV1>;
    return (
      typeof item.path === "string" &&
      typeof item.stagePath === "string" &&
      typeof item.backupPath === "string" &&
      typeof item.existedBefore === "boolean" &&
      typeof item.applied === "boolean" &&
      (item.operationKind === undefined ||
        item.operationKind === "replace-file" ||
        item.operationKind === "copy-directory" ||
        item.operationKind === "delete-artifact")
    );
  });
}
