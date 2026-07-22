import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { startBackup } from "./backup.js";
import type { DocumentRevision, RatelScopeRef, RuntimeContextRef } from "./context.js";
import { ratelConfigPath } from "./hierarchy.js";
import { nodeFs } from "./io.js";
import { isPlainObject } from "./json.js";
import {
  parseConfig,
  type RatelConfigDocument,
  type SkillEntry,
  type SkillSource,
} from "./lib/config.js";
import type { LocalGitExcludeManager } from "./local-git-exclude.js";
import type { MutationInputOperation, MutationPreview } from "./mutation-engine.js";
import {
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  validateCopySourceDirectory,
} from "./mutation-engine.js";
import type {
  PreparedChange,
  PreparedChangeCommit,
  PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";
import { assertSafeProjectControlPath } from "./project-path-safety.js";
import type { ProjectRegistry } from "./project-registry.js";
import { planSkillCopyMaterialization } from "./skill-copy-adoption.js";
import {
  type DiscoveredSkillSource,
  type SkillCandidate,
  type SkillDiscovery,
  StaleSkillCandidateError,
  UnknownSkillCandidateError,
} from "./skill-discovery.js";
import { isSafeSkillId } from "./skill-id.js";

export type SkillImportMode = "reference" | "copy";

export interface SkillImportTarget {
  scopeRef: RatelScopeRef;
  mode: SkillImportMode;
}

export interface SkillImportSelection {
  candidateId: string;
  targets: SkillImportTarget[];
}

export interface SkillImportCandidateSnapshot {
  candidateId: string;
  id: string;
  source: DiscoveredSkillSource;
  canonicalPath: string;
  context: SkillCandidate["context"];
  digest: string;
}

export interface SkillImportReview {
  selections: SkillImportSelection[];
  candidates: SkillImportCandidateSnapshot[];
  files: MutationPreview["files"];
}

export interface AppliedSkillImport {
  candidateId: string;
  id: string;
  targets: SkillImportTarget[];
}

export interface SkillImportResult {
  imported: AppliedSkillImport[];
}

export type SkillImportCommit = PreparedChangeCommit<SkillImportResult>;

export interface SkillImportControlPlaneOptions {
  homeDir: string;
  projectRegistry: ProjectRegistry;
  discovery: SkillDiscovery;
  preparedChanges: PreparedChangeCoordinator;
  localGitExcludeManager?: LocalGitExcludeManager;
}

export interface SkillImportControlPlane {
  prepare(selections: readonly SkillImportSelection[]): Promise<PreparedChange<SkillImportReview>>;
  commit(changeId: string): Promise<SkillImportCommit>;
  cancel(changeId: string): void;
}

export type SkillImportConflictReason = "digest_mismatch" | "stale_candidate" | "project_missing";

export class SkillImportConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "SKILL_IMPORT_CONFLICT";

  constructor(
    readonly reason: SkillImportConflictReason,
    message: string,
    readonly candidateId?: string,
  ) {
    super(message);
    this.name = "SkillImportConflictError";
  }
}

export class SkillImportCandidateNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "SKILL_IMPORT_CANDIDATE_NOT_FOUND";

  constructor(readonly candidateId: string) {
    super(`unknown skill candidate: ${candidateId}`);
    this.name = "SkillImportCandidateNotFoundError";
  }
}

export class SkillImportValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "SKILL_IMPORT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SkillImportValidationError";
  }
}

interface MutableTargetDocument {
  scopeRef: RatelScopeRef;
  projectRoot?: string;
  path: string;
  documentRevision: DocumentRevision;
  document: Record<string, unknown>;
  entries: Record<string, unknown>;
  localGitOperation?: MutationInputOperation;
  localGitRevision?: DocumentRevision;
}

export function createSkillImportControlPlane(
  options: SkillImportControlPlaneOptions,
): SkillImportControlPlane {
  return new FilesystemSkillImportControlPlane(options);
}

class FilesystemSkillImportControlPlane implements SkillImportControlPlane {
  constructor(private readonly options: SkillImportControlPlaneOptions) {}

  async prepare(
    selectionsInput: readonly SkillImportSelection[],
  ): Promise<PreparedChange<SkillImportReview>> {
    const selections = cloneAndValidateSelections(selectionsInput);
    const candidates = await this.resolveCandidatesForPreview(selections);
    const documents = new Map<string, MutableTargetDocument>();
    const copyOperations: MutationInputOperation[] = [];
    const registrations = new Set<string>();
    const projectRootsByPath = new Map<string, string>();
    const adoptionRevisions = new Map<string, DocumentRevision>();

    for (const selection of selections) {
      const candidate = candidates.get(selection.candidateId);
      if (!candidate) {
        throw new SkillImportCandidateNotFoundError(selection.candidateId);
      }
      assertSafeSkillId(candidate.id);

      for (const target of selection.targets) {
        const targetDocument = await this.loadTargetDocument(target.scopeRef, documents);
        if (targetDocument.projectRoot) {
          projectRootsByPath.set(targetDocument.path, targetDocument.projectRoot);
        }
        const registrationKey = `${scopeKey(target.scopeRef)}\0${candidate.id}`;
        if (registrations.has(registrationKey) || hasOwn(targetDocument.entries, candidate.id)) {
          throw new SkillImportValidationError(
            `skill registration ${JSON.stringify(candidate.id)} already exists at ${formatScope(
              target.scopeRef,
            )}`,
          );
        }
        registrations.add(registrationKey);

        targetDocument.entries[candidate.id] = await this.registrationEntry(
          candidate,
          target,
          targetDocument.projectRoot,
        );
        if (target.mode === "copy") {
          const targetPath = copyTargetPath(
            this.options.homeDir,
            target.scopeRef,
            targetDocument.projectRoot,
            candidate.id,
          );
          if (targetDocument.projectRoot) {
            await assertSafeProjectControlPath(targetDocument.projectRoot, targetPath);
          }
          const materialization = await planSkillCopyMaterialization({
            sourcePath: candidate.canonicalPath,
            targetPath,
            id: candidate.id,
          });
          copyOperations.push(...materialization.operations);
          if (materialization.adopted) {
            adoptionRevisions.set(materialization.adopted.path, materialization.adopted.revision);
          }
          if (targetDocument.projectRoot) {
            for (const operation of materialization.operations) {
              projectRootsByPath.set(operation.path, targetDocument.projectRoot);
            }
          }
        }
      }
    }

    const configOperations: MutationInputOperation[] = [];
    for (const target of documents.values()) {
      try {
        parseConfig(target.document);
      } catch (error) {
        throw new SkillImportValidationError(
          `invalid result for ${target.path}: ${(error as Error).message}`,
        );
      }
      configOperations.push({
        kind: "replace-file",
        path: target.path,
        contents: `${JSON.stringify(target.document, null, 2)}\n`,
      });
      if (target.localGitOperation) configOperations.push(target.localGitOperation);
    }

    const candidateSnapshots = [...candidates.values()].map(candidateSnapshot);
    const candidateById = new Map(
      candidateSnapshots.map((candidate) => [candidate.candidateId, candidate]),
    );
    return this.options.preparedChanges.prepare({
      kind: "skill.import",
      operations: [...configOperations, ...copyOperations],
      affectedContexts: contextsForSelections(selections),
      buildPreview: (mutation) => {
        for (const target of documents.values()) {
          const previewRevision = mutation.baseRevisions[target.path];
          if (previewRevision !== target.documentRevision) {
            throw new MutationConflictError(
              "revision_conflict",
              `skill config changed while creating preview: ${target.path}`,
              target.path,
              target.documentRevision,
              previewRevision,
            );
          }
          if (
            target.localGitOperation &&
            target.localGitRevision !== undefined &&
            mutation.baseRevisions[target.localGitOperation.path] !== target.localGitRevision
          ) {
            throw new MutationConflictError(
              "revision_conflict",
              `Git exclude changed while creating preview: ${target.localGitOperation.path}`,
              target.localGitOperation.path,
              target.localGitRevision,
              mutation.baseRevisions[target.localGitOperation.path],
            );
          }
        }
        return { selections, candidates: candidateSnapshots, files: mutation.preview.files };
      },
      invariants: {
        precondition: async () => {
          await this.assertProjectsAvailable(selections);
          for (const selection of selections) {
            const expected = candidateById.get(selection.candidateId);
            if (!expected) {
              throw new SkillImportConflictError(
                "digest_mismatch",
                `preview has no candidate metadata for ${selection.candidateId}`,
                selection.candidateId,
              );
            }
            const actual = await this.resolveCandidateForApply(selection.candidateId);
            if (!sameCandidate(expected, actual)) {
              throw new SkillImportConflictError(
                "stale_candidate",
                `skill candidate is stale: ${selection.candidateId}`,
                selection.candidateId,
              );
            }
          }
          for (const [path, projectRoot] of projectRootsByPath) {
            await assertSafeProjectControlPath(projectRoot, path);
          }
          await validateAdoptions(adoptionRevisions);
        },
        operationPrecondition: async (operation) => {
          const projectRoot = projectRootsByPath.get(operation.path);
          if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
        },
      },
      captureBackup: async () => {
        const backup = startBackup({ homeDir: this.options.homeDir }, nodeFs);
        for (const operation of [...configOperations, ...copyOperations]) {
          await backup.capture(operation.path);
        }
        return backup.finalize("import");
      },
      result: {
        imported: selections.map((selection) => {
          const candidate = candidateById.get(selection.candidateId);
          if (!candidate) {
            throw new SkillImportConflictError(
              "digest_mismatch",
              `preview has no candidate metadata for ${selection.candidateId}`,
            );
          }
          return {
            candidateId: selection.candidateId,
            id: candidate.id,
            targets: selection.targets,
          };
        }),
      },
    });
  }

  commit(changeId: string): Promise<SkillImportCommit> {
    return this.options.preparedChanges.commit(changeId);
  }

  cancel(changeId: string): void {
    this.options.preparedChanges.cancel(changeId);
  }

  private async resolveCandidatesForPreview(
    selections: readonly SkillImportSelection[],
  ): Promise<Map<string, SkillCandidate>> {
    const candidates = new Map<string, SkillCandidate>();
    for (const selection of selections) {
      if (candidates.has(selection.candidateId)) continue;
      try {
        candidates.set(
          selection.candidateId,
          await this.options.discovery.resolveCandidate(selection.candidateId),
        );
      } catch (error) {
        if (error instanceof UnknownSkillCandidateError) {
          throw new SkillImportCandidateNotFoundError(selection.candidateId);
        }
        if (error instanceof StaleSkillCandidateError) {
          throw new SkillImportConflictError(
            "stale_candidate",
            error.message,
            selection.candidateId,
          );
        }
        throw error;
      }
    }
    return candidates;
  }

  private async assertProjectsAvailable(
    selections: readonly SkillImportSelection[],
  ): Promise<void> {
    const checked = new Set<string>();
    for (const selection of selections) {
      for (const { scopeRef } of selection.targets) {
        if (scopeRef.scope === "user" || checked.has(scopeRef.projectId)) continue;
        checked.add(scopeRef.projectId);
        const project = await this.options.projectRegistry.resolve(scopeRef.projectId);
        try {
          if (!(await stat(project.canonicalRoot)).isDirectory())
            throw new Error("not a directory");
        } catch {
          throw new SkillImportConflictError(
            "project_missing",
            `project ${scopeRef.projectId} is missing: ${project.canonicalRoot}`,
          );
        }
      }
    }
  }

  private async resolveCandidateForApply(candidateId: string): Promise<SkillCandidate> {
    try {
      return await this.options.discovery.resolveCandidate(candidateId);
    } catch (error) {
      if (
        error instanceof UnknownSkillCandidateError ||
        error instanceof StaleSkillCandidateError
      ) {
        throw new SkillImportConflictError("stale_candidate", error.message, candidateId);
      }
      throw error;
    }
  }

  private async loadTargetDocument(
    scopeRef: RatelScopeRef,
    cache: Map<string, MutableTargetDocument>,
  ): Promise<MutableTargetDocument> {
    const key = scopeKey(scopeRef);
    const cached = cache.get(key);
    if (cached) return cached;

    let projectRoot: string | undefined;
    let localGitOperation: MutationInputOperation | undefined;
    let localGitRevision: DocumentRevision | undefined;
    if (scopeRef.scope !== "user") {
      const project = await this.options.projectRegistry.resolve(scopeRef.projectId);
      projectRoot = project.canonicalRoot;
      try {
        if (!(await stat(projectRoot)).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new SkillImportConflictError(
          "project_missing",
          `project ${scopeRef.projectId} is missing: ${projectRoot}`,
        );
      }
      if (scopeRef.scope === "local" && this.options.localGitExcludeManager) {
        const preview = await this.options.localGitExcludeManager.preview(projectRoot);
        if (preview.changed) {
          localGitOperation = {
            kind: "replace-file",
            path: preview.excludePath,
            contents: preview.contents,
          };
          localGitRevision = preview.documentRevision;
        }
      }
    }

    const path = ratelConfigPath(scopeRef.scope, {
      homeDir: this.options.homeDir,
      ...(projectRoot ? { projectRoot } : {}),
    });
    if (projectRoot) await assertSafeProjectControlPath(projectRoot, path);
    const read = await readConfigDocument(path);
    const document = read.document;
    const rawSkills = document.skills;
    const skills = isPlainObject(rawSkills) ? { ...rawSkills } : {};
    const rawEntries = skills.entries;
    const entries = isPlainObject(rawEntries) ? { ...rawEntries } : {};
    skills.entries = entries;
    document.skills = skills;

    const target = {
      scopeRef,
      ...(projectRoot ? { projectRoot } : {}),
      path,
      documentRevision: read.documentRevision,
      document,
      entries,
      ...(localGitOperation ? { localGitOperation } : {}),
      ...(localGitRevision ? { localGitRevision } : {}),
    };
    cache.set(key, target);
    return target;
  }

  private async registrationEntry(
    candidate: SkillCandidate,
    target: SkillImportTarget,
    projectRoot: string | undefined,
  ): Promise<SkillEntry> {
    const source = configuredSource(candidate.source);
    if (target.mode === "copy") {
      return {
        mode: "copy",
        source,
        copiedFrom: { source: candidate.source, id: candidate.id },
      };
    }

    if (target.scopeRef.scope === "user") {
      if (candidate.context.kind !== "global") {
        throw invalidReference(candidate, target.scopeRef);
      }
      return { mode: "reference", path: candidate.canonicalPath, source };
    }

    if (
      !projectRoot ||
      candidate.context.kind !== "project" ||
      candidate.context.projectRoot !== projectRoot
    ) {
      throw invalidReference(candidate, target.scopeRef);
    }
    const configuredPath = relative(projectRoot, candidate.canonicalPath);
    if (
      configuredPath.length === 0 ||
      isAbsolute(configuredPath) ||
      configuredPath === ".." ||
      configuredPath.startsWith(`..${sep}`)
    ) {
      throw invalidReference(candidate, target.scopeRef);
    }
    return { mode: "reference", path: configuredPath, source };
  }
}

function cloneAndValidateSelections(
  selections: readonly SkillImportSelection[],
): SkillImportSelection[] {
  if (selections.length === 0) {
    throw new SkillImportValidationError("skill import must contain at least one selection");
  }
  return selections.map((selection) => {
    if (!selection.candidateId || selection.targets.length === 0) {
      throw new SkillImportValidationError(
        "every skill import selection requires a candidateId and at least one target",
      );
    }
    return {
      candidateId: selection.candidateId,
      targets: selection.targets.map((target) => {
        if (target.mode !== "reference" && target.mode !== "copy") {
          throw new SkillImportValidationError(`invalid skill import mode: ${String(target.mode)}`);
        }
        assertScopeRef(target.scopeRef);
        return { scopeRef: { ...target.scopeRef }, mode: target.mode } as SkillImportTarget;
      }),
    };
  });
}

function assertScopeRef(scopeRef: RatelScopeRef): void {
  if (scopeRef.scope === "user") return;
  if (
    (scopeRef.scope !== "project" && scopeRef.scope !== "local") ||
    typeof scopeRef.projectId !== "string" ||
    scopeRef.projectId.length === 0
  ) {
    throw new SkillImportValidationError("invalid scoped skill import target");
  }
}

function assertSafeSkillId(id: string): void {
  if (!isSafeSkillId(id) || id !== basename(id)) {
    throw new SkillImportValidationError(`unsafe skill id: ${JSON.stringify(id)}`);
  }
}

async function readConfigDocument(
  path: string,
): Promise<{ document: Record<string, unknown>; documentRevision: DocumentRevision }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { document: {}, documentRevision: MISSING_DOCUMENT_REVISION };
    }
    throw error;
  }
  const raw = bytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SkillImportValidationError(`${path}: invalid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new SkillImportValidationError(`${path}: root must be a JSON object`);
  }
  try {
    parseConfig(parsed as RatelConfigDocument);
  } catch (error) {
    throw new SkillImportValidationError(`${path}: ${(error as Error).message}`);
  }
  return { document: { ...parsed }, documentRevision: documentRevision(bytes) };
}

function configuredSource(source: DiscoveredSkillSource): SkillSource {
  switch (source) {
    case "claude":
      return "claude";
    case "codex-current":
    case "codex-legacy":
      return "codex";
    case "ratel":
      return "ratel";
  }
}

function copyTargetPath(
  homeDir: string,
  scopeRef: RatelScopeRef,
  projectRoot: string | undefined,
  id: string,
): string {
  assertSafeSkillId(id);
  if (scopeRef.scope === "user") return join(homeDir, ".ratel", "skills", id);
  if (!projectRoot) {
    throw new SkillImportValidationError(`${formatScope(scopeRef)} has no registered project root`);
  }
  return scopeRef.scope === "project"
    ? join(projectRoot, ".ratel", "skills", id)
    : join(projectRoot, ".ratel", "skills.local", id);
}

async function validateAdoptions(revisions: ReadonlyMap<string, DocumentRevision>): Promise<void> {
  for (const [path, revision] of revisions) await validateAdoption(path, revision);
}

async function validateAdoption(path: string, expected: DocumentRevision): Promise<void> {
  const actual = await validateCopySourceDirectory(path);
  if (actual !== expected) {
    throw new MutationConflictError(
      "revision_conflict",
      `adopted skill directory changed after preview: ${path}`,
      path,
      expected,
      actual,
    );
  }
}

function invalidReference(candidate: SkillCandidate, scopeRef: RatelScopeRef): Error {
  return new SkillImportValidationError(
    `candidate ${candidate.candidateId} cannot be referenced from ${formatScope(
      scopeRef,
    )}; use copy instead`,
  );
}

function candidateSnapshot(candidate: SkillCandidate): SkillImportCandidateSnapshot {
  return {
    candidateId: candidate.candidateId,
    id: candidate.id,
    source: candidate.source,
    canonicalPath: candidate.canonicalPath,
    context: candidate.context,
    digest: candidate.digest,
  };
}

function sameCandidate(expected: SkillImportCandidateSnapshot, actual: SkillCandidate): boolean {
  return stableStringify(expected) === stableStringify(candidateSnapshot(actual));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

function scopeKey(scopeRef: RatelScopeRef): string {
  return scopeRef.scope === "user" ? "user" : `${scopeRef.scope}:${scopeRef.projectId}`;
}

function contextsForSelections(selections: readonly SkillImportSelection[]): RuntimeContextRef[] {
  const contexts = new Map<string, RuntimeContextRef>();
  for (const selection of selections) {
    for (const { scopeRef } of selection.targets) {
      const context: RuntimeContextRef =
        scopeRef.scope === "user"
          ? { kind: "global" }
          : { kind: "project", projectId: scopeRef.projectId };
      contexts.set(context.kind === "global" ? "global" : `project:${context.projectId}`, context);
    }
  }
  return [...contexts.values()];
}

function formatScope(scopeRef: RatelScopeRef): string {
  return scopeRef.scope === "user"
    ? "user"
    : `${scopeRef.scope} scope of project ${scopeRef.projectId}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
