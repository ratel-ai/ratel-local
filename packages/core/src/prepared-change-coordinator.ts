import { randomUUID } from "node:crypto";
import type { BackupManifest } from "./backup.js";
import type { RuntimeContextRef } from "./context.js";
import type {
  MutationCommit,
  MutationEngine,
  MutationInputOperation,
  MutationOperation,
  PreparedMutation,
} from "./mutation-engine.js";

export const PREPARED_CHANGE_LIFETIME_MS = 10 * 60 * 1_000;
export const MAX_PREPARED_CHANGES = 128;

export interface PreparedChange<ReviewData = unknown> {
  changeId: string;
  kind: string;
  expiresAt: string;
  preview: ReviewData;
}

export interface PreparedChangeCommit<DomainResult = unknown> extends MutationCommit {
  backupManifest: BackupManifest | null;
  result: DomainResult;
}

export interface PreparedChangeInvariants {
  precondition?: () => void | Promise<void>;
  operationPrecondition?: (operation: MutationOperation, index: number) => void | Promise<void>;
}

export interface PrepareChangeInput<ReviewData, DomainResult> {
  kind: string;
  operations: readonly MutationInputOperation[];
  preview?: ReviewData;
  buildPreview?: (mutation: Readonly<PreparedMutation>) => ReviewData;
  affectedContexts?: readonly RuntimeContextRef[];
  captureBackup?: () => Promise<BackupManifest | null>;
  invariants?: PreparedChangeInvariants;
  beforeCommit?: () => Promise<
    { action: "commit"; result?: DomainResult } | { action: "cancel"; result?: DomainResult }
  >;
  result: DomainResult | ((commit: MutationCommit) => DomainResult | Promise<DomainResult>);
}

export interface PreparedChangeCoordinatorOptions {
  mutationEngine: MutationEngine;
  publish?: (
    contexts: readonly RuntimeContextRef[],
    commit: MutationCommit,
  ) => void | Promise<void>;
  now?: () => Date;
  idFactory?: () => string;
  lifetimeMs?: number;
  capacity?: number;
}

export interface PreparedChangeCoordinator {
  prepare<ReviewData, DomainResult>(
    input: PrepareChangeInput<ReviewData, DomainResult>,
  ): Promise<PreparedChange<ReviewData>>;
  commit<DomainResult = unknown>(changeId: string): Promise<PreparedChangeCommit<DomainResult>>;
  cancel(changeId: string): void;
}

interface StoredPreparedChange {
  kind: string;
  expiresAtMs: number;
  mutation: PreparedMutation;
  affectedContexts: readonly RuntimeContextRef[];
  captureBackup?: () => Promise<BackupManifest | null>;
  invariants?: PreparedChangeInvariants;
  beforeCommit?: () => Promise<
    { action: "commit"; result?: unknown } | { action: "cancel"; result?: unknown }
  >;
  result: unknown | ((commit: MutationCommit) => unknown | Promise<unknown>);
}

class PreparedChangeCancelledDuringCommit extends Error {}

export class PreparedChangeUnavailableError extends Error {
  readonly statusCode = 409;
  readonly code = "PREPARED_CHANGE_UNAVAILABLE";

  constructor(readonly changeId: string) {
    super(`prepared change is missing, expired, evicted, or already consumed: ${changeId}`);
    this.name = "PreparedChangeUnavailableError";
  }
}

export function createPreparedChangeCoordinator(
  options: PreparedChangeCoordinatorOptions,
): PreparedChangeCoordinator {
  return new InMemoryPreparedChangeCoordinator(options);
}

class InMemoryPreparedChangeCoordinator implements PreparedChangeCoordinator {
  private readonly changes = new Map<string, StoredPreparedChange>();
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly lifetimeMs: number;
  private readonly capacity: number;

  constructor(private readonly options: PreparedChangeCoordinatorOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.lifetimeMs = options.lifetimeMs ?? PREPARED_CHANGE_LIFETIME_MS;
    this.capacity = options.capacity ?? MAX_PREPARED_CHANGES;
    if (!Number.isFinite(this.lifetimeMs) || this.lifetimeMs <= 0) {
      throw new Error("prepared change lifetime must be positive");
    }
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error("prepared change capacity must be a positive integer");
    }
  }

  async prepare<ReviewData, DomainResult>(
    input: PrepareChangeInput<ReviewData, DomainResult>,
  ): Promise<PreparedChange<ReviewData>> {
    if ((input.preview === undefined) === (input.buildPreview === undefined)) {
      throw new Error("prepared change requires exactly one preview source");
    }
    const mutation = await this.options.mutationEngine.prepare(input.operations);
    const preview = input.buildPreview
      ? input.buildPreview(structuredClone(mutation))
      : (input.preview as ReviewData);
    const now = this.now();
    this.removeExpired(now.getTime());
    while (this.changes.size >= this.capacity) {
      const oldest = this.changes.keys().next().value;
      if (typeof oldest !== "string") break;
      this.changes.delete(oldest);
    }
    const changeId = this.uniqueChangeId();
    const expiresAtMs = now.getTime() + this.lifetimeMs;
    this.changes.set(changeId, {
      kind: input.kind,
      expiresAtMs,
      mutation: structuredClone(mutation),
      affectedContexts: structuredClone(input.affectedContexts ?? []),
      captureBackup: input.captureBackup,
      invariants: input.invariants,
      beforeCommit: input.beforeCommit,
      result: input.result,
    });
    return {
      changeId,
      kind: input.kind,
      expiresAt: new Date(expiresAtMs).toISOString(),
      preview: structuredClone(preview),
    };
  }

  async commit<DomainResult = unknown>(
    changeId: string,
  ): Promise<PreparedChangeCommit<DomainResult>> {
    const stored = this.take(changeId);
    let decision:
      | { action: "commit"; result?: unknown }
      | { action: "cancel"; result?: unknown }
      | undefined;
    let backupManifest: BackupManifest | null = null;
    let commit: MutationCommit;
    try {
      commit = await this.options.mutationEngine.commit(stored.mutation, {
        digest: stored.mutation.digest,
        precondition: async () => {
          await stored.invariants?.precondition?.();
          decision = await stored.beforeCommit?.();
          if (decision?.action === "cancel") {
            throw new PreparedChangeCancelledDuringCommit();
          }
          backupManifest = (await stored.captureBackup?.()) ?? null;
        },
        operationPrecondition: stored.invariants?.operationPrecondition,
      });
    } catch (error) {
      if (!(error instanceof PreparedChangeCancelledDuringCommit)) throw error;
      const emptyCommit = { transactionId: changeId, changedPaths: [], revisions: {} };
      const result =
        decision?.result !== undefined
          ? structuredClone(decision.result)
          : typeof stored.result === "function"
            ? await stored.result(emptyCommit)
            : structuredClone(stored.result);
      return {
        ...emptyCommit,
        backupManifest: null,
        result: result as DomainResult,
      };
    }
    await this.options.publish?.(structuredClone(stored.affectedContexts), commit);
    const result =
      decision?.result !== undefined
        ? structuredClone(decision.result)
        : typeof stored.result === "function"
          ? await stored.result(commit)
          : structuredClone(stored.result);
    return {
      ...commit,
      backupManifest,
      result: result as DomainResult,
    };
  }

  cancel(changeId: string): void {
    this.removeExpired(this.now().getTime());
    this.changes.delete(changeId);
  }

  private take(changeId: string): StoredPreparedChange {
    const now = this.now().getTime();
    this.removeExpired(now);
    const stored = this.changes.get(changeId);
    if (!stored || now >= stored.expiresAtMs) {
      this.changes.delete(changeId);
      throw new PreparedChangeUnavailableError(changeId);
    }
    // Consume before awaiting so concurrent callers cannot replay a change.
    this.changes.delete(changeId);
    return stored;
  }

  private removeExpired(now: number): void {
    for (const [changeId, stored] of this.changes) {
      if (now >= stored.expiresAtMs) this.changes.delete(changeId);
    }
  }

  private uniqueChangeId(): string {
    for (;;) {
      const id = this.idFactory();
      if (/^[A-Za-z0-9_-]{1,128}$/.test(id) && !this.changes.has(id)) return id;
    }
  }
}
