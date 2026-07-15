import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BackupFs, type BackupManifest, startBackup } from "./backup.js";
import type { HierarchyEnv } from "./hierarchy.js";
import type { FileChange } from "./import-plan.js";
import { type JsonFs, nodeFs } from "./io.js";
import { isPlainObject, stableJsonStringify } from "./json.js";
import {
  createMutationEngine,
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  type MutationEngine,
  type MutationInputOperation,
  MutationValidationError,
} from "./mutation-engine.js";
import { assertSafeProjectControlPath } from "./project-path-safety.js";

export interface ExecuteOptions {
  fs: JsonFs & BackupFs;
  env: HierarchyEnv;
  action: BackupManifest["action"];
  now?: () => Date;
}

export interface TransactionalExecuteOptions extends ExecuteOptions {
  /** Primarily useful for tests and callers sharing a configured engine. */
  mutationEngine?: MutationEngine;
}

export type PlanExecutor = (
  changes: readonly FileChange[],
  opts: TransactionalExecuteOptions,
) => Promise<BackupManifest>;

/**
 * Executes a legacy FileChange plan through the shared recoverable mutation
 * engine. The original executePlan export remains available for injected
 * in-memory filesystems that predate the control plane.
 */
export async function executePlanTransactionally(
  changes: readonly FileChange[],
  opts: TransactionalExecuteOptions,
): Promise<BackupManifest> {
  const now = opts.now ?? (() => new Date());
  if (changes.length === 0) {
    return { createdAt: now().toISOString(), action: opts.action, entries: [] };
  }

  if (opts.fs !== nodeFs) {
    throw new MutationValidationError(
      "transactional plan execution requires nodeFs; inject executePlan explicitly for legacy filesystems",
    );
  }

  assertUniqueWritePaths(changes);
  await assertSafeProjectChanges(changes, opts.env.projectRoot);
  const mutationEngine =
    opts.mutationEngine ??
    (await createMutationEngine({ controlDir: join(opts.env.homeDir, ".ratel") }));
  const operations: MutationInputOperation[] = changes.map((change) => ({
    kind: "replace-file",
    path: change.path,
    contents: change.after,
  }));
  const plan = await mutationEngine.preview(operations);
  for (const change of changes) {
    const actualRevision = plan.baseRevisions[change.path];
    const expectedRevision =
      change.before === null ? MISSING_DOCUMENT_REVISION : documentRevision(change.before);
    if (actualRevision === expectedRevision) continue;
    const current = await opts.fs.read(change.path);
    const currentRevision =
      current === null ? MISSING_DOCUMENT_REVISION : documentRevision(current);
    if (currentRevision !== actualRevision) {
      throw new MutationConflictError(
        "revision_conflict",
        `document changed while validating plan snapshot: ${change.path}`,
        change.path,
        actualRevision,
        currentRevision,
      );
    }
    if (equivalentPlanSnapshot(change.before, current)) continue;
    throw new MutationConflictError(
      "revision_conflict",
      `document changed after plan creation: ${change.path}`,
      change.path,
      expectedRevision,
      actualRevision,
    );
  }

  let manifest: BackupManifest | undefined;
  await mutationEngine.apply(plan, {
    digest: plan.digest,
    precondition: async () => {
      await assertSafeProjectChanges(changes, opts.env.projectRoot);
      const session = startBackup(opts.env, opts.fs, now);
      for (const change of changes) await session.capture(change.path);
      manifest = await session.finalize(opts.action);
    },
    operationPrecondition: async (operation) => {
      if (opts.env.projectRoot && isWithinProject(opts.env.projectRoot, operation.path)) {
        await assertSafeProjectControlPath(opts.env.projectRoot, operation.path);
      }
    },
  });
  if (!manifest) throw new Error("mutation backup precondition did not run");
  return manifest;
}

async function assertSafeProjectChanges(
  changes: readonly FileChange[],
  projectRoot: string | undefined,
): Promise<void> {
  if (!projectRoot) return;
  for (const change of changes) {
    if (isWithinProject(projectRoot, change.path)) {
      await assertSafeProjectControlPath(projectRoot, change.path);
    }
  }
}

function isWithinProject(projectRoot: string, path: string): boolean {
  const fromRoot = relative(resolve(projectRoot), resolve(path));
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

export async function executePlan(
  changes: readonly FileChange[],
  opts: ExecuteOptions,
): Promise<BackupManifest> {
  const now = opts.now ?? (() => new Date());

  if (changes.length === 0) {
    return { createdAt: now().toISOString(), action: opts.action, entries: [] };
  }

  assertUniqueWritePaths(changes);

  const session = startBackup(opts.env, opts.fs, now);
  for (const c of changes) {
    if (c.kind === "write") {
      await session.capture(c.path);
    }
  }
  const manifest = await session.finalize(opts.action);

  const written: string[] = [];
  try {
    for (const c of changes) {
      if (c.kind === "write") {
        await opts.fs.writeAtomic(c.path, c.after);
        written.push(c.path);
      }
    }
  } catch (err) {
    for (const path of written) {
      const entry = manifest.entries.find((e) => e.originalPath === path);
      if (!entry) continue;
      if (entry.existedBefore) {
        const text = await opts.fs.read(entry.backupPath);
        if (text !== null) await opts.fs.writeAtomic(path, text);
      } else {
        await opts.fs.remove(path);
      }
    }
    throw err;
  }

  return manifest;
}

function assertUniqueWritePaths(changes: readonly FileChange[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.path)) {
      throw new Error(`plan would write ${change.path} twice`);
    }
    seen.add(change.path);
  }
}

function equivalentPlanSnapshot(expected: string | null, actual: string | null): boolean {
  if (expected === actual) return true;
  if (expected === null || actual === null) return false;
  try {
    return canonicalJsonSnapshot(expected) === canonicalJsonSnapshot(actual);
  } catch {
    return false;
  }
}

function canonicalJsonSnapshot(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed)) return stableJsonStringify(parsed);
  const root = structuredClone(parsed);
  if (root.mcpServers === undefined) root.mcpServers = {};
  if (!isPlainObject(root.mcpServers)) return stableJsonStringify(root);
  const servers = root.mcpServers;
  for (const entry of Object.values(servers)) {
    if (isPlainObject(entry) && entry.type === undefined) entry.type = "stdio";
  }
  return stableJsonStringify(root);
}
