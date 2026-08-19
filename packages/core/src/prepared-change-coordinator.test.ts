import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectId } from "./context.js";
import { createMutationEngine } from "./mutation-engine.js";
import {
  createPreparedChangeCoordinator,
  PreparedChangeUnavailableError,
} from "./prepared-change-coordinator.js";

describe("PreparedChangeCoordinator", () => {
  let root: string;
  let now: Date;
  let nextId: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ratel-prepared-change-"));
    now = new Date("2026-01-01T00:00:00.000Z");
    nextId = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns review data only and commits its private mutation exactly once", async () => {
    const target = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({
      mutationEngine: engine,
      now: () => now,
      idFactory: () => `change-${++nextId}`,
    });

    const prepared = await coordinator.prepare({
      kind: "mcp.add",
      operations: [{ kind: "replace-file", path: target, contents: "planned" }],
      preview: { label: "Add MCP server" },
      result: { name: "example" },
    });

    expect(prepared).toEqual({
      changeId: "change-1",
      kind: "mcp.add",
      expiresAt: "2026-01-01T00:10:00.000Z",
      preview: { label: "Add MCP server" },
    });
    expect(prepared).not.toHaveProperty("operations");
    const commit = await coordinator.commit<{ name: string }>(prepared.changeId);
    expect(await readFile(target, "utf8")).toBe("planned");
    expect(commit.result).toEqual({ name: "example" });
    await expect(coordinator.commit(prepared.changeId)).rejects.toBeInstanceOf(
      PreparedChangeUnavailableError,
    );
  });

  it("cancels idempotently and expired changes never write", async () => {
    const target = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({
      mutationEngine: engine,
      now: () => now,
      idFactory: () => `change-${++nextId}`,
    });
    const cancelled = await coordinator.prepare({
      kind: "cancelled",
      operations: [{ kind: "replace-file", path: target, contents: "cancelled" }],
      preview: {},
      result: null,
    });
    coordinator.cancel(cancelled.changeId);
    coordinator.cancel(cancelled.changeId);
    await expect(coordinator.commit(cancelled.changeId)).rejects.toMatchObject({
      statusCode: 409,
      code: "PREPARED_CHANGE_UNAVAILABLE",
    });

    const expired = await coordinator.prepare({
      kind: "expired",
      operations: [{ kind: "replace-file", path: target, contents: "expired" }],
      preview: {},
      result: null,
    });
    now = new Date("2026-01-01T00:10:00.000Z");
    await expect(coordinator.commit(expired.changeId)).rejects.toMatchObject({
      code: "PREPARED_CHANGE_UNAVAILABLE",
    });
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("evicts FIFO, keeps the private mutation immutable, and publishes stored contexts", async () => {
    const firstTarget = join(root, "first.json");
    const secondTarget = join(root, "second.json");
    const projectId = "project-1" as ProjectId;
    const publish = vi.fn();
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({
      mutationEngine: engine,
      capacity: 1,
      now: () => now,
      idFactory: () => `change-${++nextId}`,
      publish,
    });
    const review = { files: [firstTarget] };
    const contexts = [{ kind: "project" as const, projectId }];
    const first = await coordinator.prepare({
      kind: "first",
      operations: [{ kind: "replace-file", path: firstTarget, contents: "first" }],
      affectedContexts: contexts,
      preview: review,
      result: "first",
    });
    review.files[0] = "tampered";
    contexts[0] = { kind: "project", projectId: "tampered" as ProjectId };
    const second = await coordinator.prepare({
      kind: "second",
      operations: [{ kind: "replace-file", path: secondTarget, contents: "second" }],
      affectedContexts: [{ kind: "project", projectId }],
      preview: {},
      result: "second",
    });
    await expect(coordinator.commit(first.changeId)).rejects.toMatchObject({
      code: "PREPARED_CHANGE_UNAVAILABLE",
    });
    await coordinator.commit(second.changeId);
    expect(await readFile(secondTarget, "utf8")).toBe("second");
    expect(publish).toHaveBeenCalledWith(
      [{ kind: "project", projectId }],
      expect.objectContaining({ changedPaths: [secondTarget] }),
    );
  });

  it("consumes before commit so concurrent callers cannot replay", async () => {
    const target = join(root, "config.json");
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({
      mutationEngine: engine,
      idFactory: () => `change-${++nextId}`,
    });
    const prepared = await coordinator.prepare({
      kind: "concurrent",
      operations: [{ kind: "replace-file", path: target, contents: "once" }],
      preview: {},
      result: null,
    });
    const results = await Promise.allSettled([
      coordinator.commit(prepared.changeId),
      coordinator.commit(prepared.changeId),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  });

  it("uses the default 128-entry FIFO bound", async () => {
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({
      mutationEngine: engine,
      idFactory: () => `change-${++nextId}`,
    });
    const prepared = [];
    for (let index = 0; index < 129; index += 1) {
      prepared.push(
        await coordinator.prepare({
          kind: "bounded",
          operations: [],
          preview: { index },
          result: index,
        }),
      );
    }
    await expect(coordinator.commit(prepared[0]?.changeId ?? "missing")).rejects.toMatchObject({
      code: "PREPARED_CHANGE_UNAVAILABLE",
    });
    await expect(
      coordinator.commit<number>(prepared[1]?.changeId ?? "missing"),
    ).resolves.toMatchObject({
      result: 1,
    });
  });

  it("checks filesystem revisions before running non-transactional orchestration", async () => {
    const target = join(root, "agent.json");
    await writeFile(target, "before");
    const beforeCommit = vi.fn(async () => ({ action: "commit" as const }));
    const engine = await createMutationEngine({ controlDir: join(root, "control") });
    const coordinator = createPreparedChangeCoordinator({ mutationEngine: engine });
    const prepared = await coordinator.prepare({
      kind: "agent.link",
      operations: [{ kind: "replace-file", path: target, contents: "fallback" }],
      preview: {},
      beforeCommit,
      result: null,
    });
    await writeFile(target, "stale");

    await expect(coordinator.commit(prepared.changeId)).rejects.toMatchObject({
      code: "MUTATION_CONFLICT",
      reason: "revision_conflict",
    });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("stale");
  });
});
