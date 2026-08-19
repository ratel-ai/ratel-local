import {
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  type MutationCommit,
  MutationConflictError,
  type PrepareChangeInput,
  type PreparedChangeCoordinator,
  type PreparedMutation,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "./types.js";

interface StoredChange {
  input: PrepareChangeInput<unknown, unknown>;
  mutation: PreparedMutation;
}

export function createTestPreparedChanges(fs: HandlerCtx["fs"]): PreparedChangeCoordinator {
  let nextId = 0;
  const changes = new Map<string, StoredChange>();
  return {
    async prepare<ReviewData, DomainResult>(input: PrepareChangeInput<ReviewData, DomainResult>) {
      const baseRevisions: PreparedMutation["baseRevisions"] = {};
      const operations: PreparedMutation["operations"] = [];
      const files: PreparedMutation["preview"]["files"] = [];
      for (const operation of input.operations) {
        if (operation.kind !== "replace-file") {
          throw new Error(`test coordinator does not support ${operation.kind}`);
        }
        const before = await fs.read(operation.path);
        const after =
          typeof operation.contents === "string"
            ? operation.contents
            : Buffer.from(operation.contents).toString("utf8");
        const beforeRevision =
          before === null ? MISSING_DOCUMENT_REVISION : documentRevision(before);
        baseRevisions[operation.path] = beforeRevision;
        operations.push({
          kind: "replace-file",
          path: operation.path,
          contentsBase64: Buffer.from(after).toString("base64"),
        });
        files.push({
          kind: "file",
          path: operation.path,
          existedBefore: before !== null,
          beforeRevision,
          afterRevision: documentRevision(after),
        });
      }
      const mutation: PreparedMutation = {
        id: `mutation-${nextId}`,
        digest: "test" as PreparedMutation["digest"],
        baseRevisions,
        operations,
        preview: { files },
      };
      const preview = input.buildPreview
        ? input.buildPreview(structuredClone(mutation))
        : (input.preview as ReviewData);
      const changeId = `change-${nextId++}`;
      changes.set(changeId, {
        input: input as PrepareChangeInput<unknown, unknown>,
        mutation,
      });
      return {
        changeId,
        kind: input.kind,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        preview,
      };
    },
    async commit<DomainResult>(changeId: string) {
      const stored = changes.get(changeId);
      changes.delete(changeId);
      if (!stored) throw new Error(`unavailable prepared change: ${changeId}`);
      for (const operation of stored.mutation.operations) {
        const before = await fs.read(operation.path);
        const actual = before === null ? MISSING_DOCUMENT_REVISION : documentRevision(before);
        const expected = stored.mutation.baseRevisions[operation.path];
        if (actual !== expected) {
          throw new MutationConflictError(
            "revision_conflict",
            `document changed after preparation: ${operation.path}`,
            operation.path,
            expected,
            actual,
          );
        }
      }
      await stored.input.invariants?.precondition?.();
      const decision = await stored.input.beforeCommit?.();
      if (decision?.action === "cancel") {
        return {
          transactionId: changeId,
          changedPaths: [],
          revisions: {},
          backupManifest: null,
          result: decision.result as DomainResult,
        };
      }
      const backupManifest = (await stored.input.captureBackup?.()) ?? null;
      const beforeWrites = new Map<string, string | null>();
      const revisions: MutationCommit["revisions"] = {};
      try {
        for (const [index, operation] of stored.mutation.operations.entries()) {
          await stored.input.invariants?.operationPrecondition?.(operation, index);
          if (operation.kind !== "replace-file") {
            throw new Error(`test coordinator does not support ${operation.kind}`);
          }
          beforeWrites.set(operation.path, await fs.read(operation.path));
          const after = Buffer.from(operation.contentsBase64, "base64").toString("utf8");
          await fs.writeAtomic(operation.path, after);
          revisions[operation.path] = documentRevision(after);
        }
      } catch (error) {
        for (const [path, before] of beforeWrites) {
          if (before === null) await fs.remove(path);
          else await fs.writeAtomic(path, before);
        }
        throw error;
      }
      const commit: MutationCommit = {
        transactionId: changeId,
        changedPaths: stored.mutation.operations.map(({ path }) => path),
        revisions,
      };
      const result =
        decision?.result !== undefined
          ? decision.result
          : typeof stored.input.result === "function"
            ? await (stored.input.result as (value: MutationCommit) => unknown)(commit)
            : stored.input.result;
      return { ...commit, backupManifest, result: result as DomainResult };
    },
    cancel(changeId: string) {
      changes.delete(changeId);
    },
  };
}
