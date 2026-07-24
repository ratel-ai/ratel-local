import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { startBackup } from "./backup.js";
import type { ConfigControlPlane } from "./config-control-plane.js";
import type { DocumentRevision, RatelScopeRef, RuntimeContextRef } from "./context.js";
import type { ContextSnapshotResolver } from "./context-snapshot.js";
import { nodeFs } from "./io.js";
import { isPlainObject } from "./json.js";
import type { SkillSource } from "./lib/config.js";
import { parseConfig, parseSkillMd, type SkillEntry } from "./lib/index.js";
import { loadSkillBundle } from "./lib/skills/load.js";
import type { SkillRegistrationView } from "./lib/skills/resolve.js";
import type { LocalGitExcludeManager } from "./local-git-exclude.js";
import {
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  type MutationInputOperation,
  type MutationPreview,
  type PreparedMutation,
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
import { rewriteSkillDocument, stripBundledResourceIndex } from "./skill-document.js";
import { isSafeSkillId } from "./skill-id.js";

export interface RemoveSkillRegistrationRequest {
  target: RatelScopeRef;
  id: string;
  /** `false` implements remove-scope; `true` implements remove. */
  deleteOwnedCopy: boolean;
}

export interface EditSkillRegistrationRequest {
  target: RatelScopeRef;
  id: string;
  description: string;
  tags: string[];
  body: string;
  expectedRevision?: DocumentRevision;
}

export interface CreateSkillRegistrationRequest {
  target: RatelScopeRef;
  id: string;
  description: string;
  tags: string[];
  body: string;
}

export interface AddSkillScopeRequest {
  context: RuntimeContextRef;
  target: RatelScopeRef;
  id: string;
  mode: "reference" | "copy";
}

export interface SkillRegistrationControlPlaneOptions {
  homeDir: string;
  projectRegistry: ProjectRegistry;
  configControlPlane: ConfigControlPlane;
  snapshotResolver: ContextSnapshotResolver;
  preparedChanges: PreparedChangeCoordinator;
  localGitExcludeManager?: LocalGitExcludeManager;
}

export interface SkillRegistrationControlPlane {
  prepareCreate(
    request: CreateSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>>;
  prepareAddScope(request: AddSkillScopeRequest): Promise<PreparedChange<SkillRegistrationReview>>;
  prepareEdit(
    request: EditSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>>;
  prepareRemove(
    request: RemoveSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>>;
  commit(changeId: string): Promise<SkillRegistrationCommit>;
  cancel(changeId: string): void;
  create(request: CreateSkillRegistrationRequest): Promise<SkillRegistrationCommit>;
  addScope(request: AddSkillScopeRequest): Promise<SkillRegistrationCommit>;
  edit(request: EditSkillRegistrationRequest): Promise<SkillRegistrationCommit>;
  remove(request: RemoveSkillRegistrationRequest): Promise<SkillRegistrationCommit>;
}

export interface SkillRegistrationReview {
  action: "create" | "add-scope" | "edit" | "remove";
  target: RatelScopeRef;
  id: string;
  files: MutationPreview["files"];
}

export interface SkillRegistrationResult {
  action: SkillRegistrationReview["action"];
  target: RatelScopeRef;
  id: string;
}

export type SkillRegistrationCommit = PreparedChangeCommit<SkillRegistrationResult>;

export class SkillRegistrationNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "SKILL_REGISTRATION_NOT_FOUND";

  constructor(
    readonly target: RatelScopeRef,
    readonly id: string,
  ) {
    super(`unknown skill registration ${JSON.stringify(id)} in ${formatScope(target)}`);
    this.name = "SkillRegistrationNotFoundError";
  }
}

export class SkillRegistrationConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "SKILL_REGISTRATION_CONFLICT";

  constructor(
    readonly reason: "copy_still_referenced" | "registration_exists",
    message: string,
  ) {
    super(message);
    this.name = "SkillRegistrationConflictError";
  }
}

export class SkillRegistrationValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "SKILL_REGISTRATION_INVALID";

  constructor(
    readonly reason: "copy_not_owned" | "invalid_registration" | "registration_not_editable",
    message: string,
  ) {
    super(message);
    this.name = "SkillRegistrationValidationError";
  }
}

export function createSkillRegistrationControlPlane(
  options: SkillRegistrationControlPlaneOptions,
): SkillRegistrationControlPlane {
  return new FilesystemSkillRegistrationControlPlane(options);
}

class FilesystemSkillRegistrationControlPlane implements SkillRegistrationControlPlane {
  constructor(private readonly options: SkillRegistrationControlPlaneOptions) {}

  async prepareCreate(
    request: CreateSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>> {
    validateRegistrationId(request.id);
    if (
      typeof request.description !== "string" ||
      request.description.trim().length === 0 ||
      !Array.isArray(request.tags) ||
      request.tags.some((tag) => typeof tag !== "string") ||
      typeof request.body !== "string"
    ) {
      throw new SkillRegistrationValidationError(
        "invalid_registration",
        "description, tags, and body must form a valid skill document",
      );
    }

    const current = await this.options.configControlPlane.read(request.target);
    const document = { ...current.document } as Record<string, unknown>;
    const skills = isPlainObject(document.skills) ? { ...document.skills } : {};
    const entries = isPlainObject(skills.entries) ? { ...skills.entries } : {};
    if (Object.hasOwn(entries, request.id)) {
      throw new SkillRegistrationConflictError(
        "registration_exists",
        `skill registration ${JSON.stringify(request.id)} already exists in ${formatScope(request.target)}`,
      );
    }

    const projectRoot = await this.projectRootForTarget(request.target);
    const copyPath = await this.ownedCopyPath(request.target, request.id);
    if (await artifactExists(copyPath)) {
      throw new SkillRegistrationConflictError(
        "registration_exists",
        `skill copy ${JSON.stringify(request.id)} already exists in ${formatScope(request.target)}`,
      );
    }
    const skillPath = join(copyPath, "SKILL.md");
    const markerPath = join(copyPath, ".ratel-skill.json");
    const contents = buildSkillDocument(request);
    try {
      parseSkillMd(contents, skillPath, request.id);
    } catch (error) {
      throw new SkillRegistrationValidationError("invalid_registration", (error as Error).message);
    }

    entries[request.id] = { mode: "copy", source: "ratel" } satisfies SkillEntry;
    skills.entries = entries;
    document.skills = skills;
    try {
      parseConfig(document);
    } catch (error) {
      throw new SkillRegistrationValidationError("invalid_registration", (error as Error).message);
    }

    const operations: MutationInputOperation[] = [
      {
        kind: "replace-file",
        path: current.path,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
      { kind: "replace-file", path: skillPath, contents },
      {
        kind: "replace-file",
        path: markerPath,
        contents: `${JSON.stringify({ version: 1, id: request.id })}\n`,
      },
    ];
    let localGitPath: string | undefined;
    let localGitRevision: DocumentRevision | undefined;
    if (request.target.scope === "local" && this.options.localGitExcludeManager && projectRoot) {
      const preview = await this.options.localGitExcludeManager.preview(projectRoot);
      if (preview.changed) {
        localGitPath = preview.excludePath;
        localGitRevision = preview.documentRevision;
        operations.push({
          kind: "replace-file",
          path: preview.excludePath,
          contents: preview.contents,
        });
      }
    }

    const projectRootsByPath = new Map<string, string>();
    if (projectRoot) {
      for (const operation of operations) {
        if (operation.path !== localGitPath) projectRootsByPath.set(operation.path, projectRoot);
      }
    }
    return this.prepareRegistrationChange({
      action: "create",
      target: request.target,
      id: request.id,
      operations,
      projectRootsByPath,
      verifyPreview: (mutation) => {
        if (mutation.baseRevisions[current.path] !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `config changed while creating skill: ${current.path}`,
            current.path,
            current.documentRevision,
            mutation.baseRevisions[current.path],
          );
        }
        if (
          mutation.baseRevisions[skillPath] !== MISSING_DOCUMENT_REVISION ||
          mutation.baseRevisions[markerPath] !== MISSING_DOCUMENT_REVISION
        ) {
          throw new SkillRegistrationConflictError(
            "registration_exists",
            `skill copy ${JSON.stringify(request.id)} already exists in ${formatScope(request.target)}`,
          );
        }
        if (
          localGitPath &&
          localGitRevision &&
          mutation.baseRevisions[localGitPath] !== localGitRevision
        ) {
          throw new MutationConflictError(
            "revision_conflict",
            `Git exclude changed while creating skill: ${localGitPath}`,
            localGitPath,
            localGitRevision,
            mutation.baseRevisions[localGitPath],
          );
        }
      },
      precondition: async () => {
        const latest = await this.options.configControlPlane.read(request.target);
        if (latest.documentRevision !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `skill registration changed after preview: ${current.path}`,
            current.path,
            current.documentRevision,
            latest.documentRevision,
          );
        }
        if (await artifactExists(copyPath)) {
          throw new SkillRegistrationConflictError(
            "registration_exists",
            `skill copy ${JSON.stringify(request.id)} already exists in ${formatScope(request.target)}`,
          );
        }
      },
    });
  }

  async prepareAddScope(
    request: AddSkillScopeRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>> {
    validateRegistrationId(request.id);
    if (request.mode !== "reference" && request.mode !== "copy") {
      throw new SkillRegistrationValidationError(
        "invalid_registration",
        "skill registration mode must be reference or copy",
      );
    }
    const sourceSnapshot = await this.options.snapshotResolver.resolve(request.context);
    const sourceRegistration = sourceSnapshot.skills.registrations.find(
      (registration) =>
        registration.id === request.id &&
        registration.state === "effective" &&
        registration.canonicalPath !== undefined,
    );
    if (!sourceRegistration?.canonicalPath) {
      throw new SkillRegistrationNotFoundError(request.target, request.id);
    }
    const canonicalSource = await realpath(sourceRegistration.canonicalPath);
    await loadSkillBundle(canonicalSource, request.id);

    const current = await this.options.configControlPlane.read(request.target);
    const document = { ...current.document } as Record<string, unknown>;
    const skills = isPlainObject(document.skills) ? { ...document.skills } : {};
    const entries = isPlainObject(skills.entries) ? { ...skills.entries } : {};
    if (Object.hasOwn(entries, request.id)) {
      throw new SkillRegistrationConflictError(
        "registration_exists",
        `skill registration ${JSON.stringify(request.id)} already exists in ${formatScope(request.target)}`,
      );
    }

    const projectRoot = await this.projectRootForTarget(request.target);
    const source = normalizeSkillSource(sourceRegistration.source);
    const operations: MutationInputOperation[] = [];
    let adoptedCopy: { path: string; revision: DocumentRevision } | undefined;
    if (request.mode === "reference") {
      entries[request.id] = {
        mode: "reference",
        path: referencePathForTarget(request.target, projectRoot, canonicalSource),
        source,
      } satisfies SkillEntry;
    } else {
      entries[request.id] = {
        mode: "copy",
        source,
        copiedFrom: { source: sourceRegistration.source, id: request.id },
      } satisfies SkillEntry;
      const targetPath = await this.ownedCopyPath(request.target, request.id);
      const materialization = await planSkillCopyMaterialization({
        sourcePath: canonicalSource,
        targetPath,
        id: request.id,
      });
      operations.push(...materialization.operations);
      adoptedCopy = materialization.adopted;
    }
    skills.entries = entries;
    document.skills = skills;
    try {
      parseConfig(document);
    } catch (error) {
      throw new SkillRegistrationValidationError("invalid_registration", (error as Error).message);
    }

    operations.unshift({
      kind: "replace-file",
      path: current.path,
      contents: `${JSON.stringify(document, null, 2)}\n`,
    });
    let localGitPath: string | undefined;
    let localGitRevision: DocumentRevision | undefined;
    if (request.target.scope === "local" && this.options.localGitExcludeManager && projectRoot) {
      const preview = await this.options.localGitExcludeManager.preview(projectRoot);
      if (preview.changed) {
        localGitPath = preview.excludePath;
        localGitRevision = preview.documentRevision;
        operations.push({
          kind: "replace-file",
          path: preview.excludePath,
          contents: preview.contents,
        });
      }
    }

    const projectRootsByPath = new Map<string, string>();
    if (projectRoot) {
      for (const operation of operations) {
        if (operation.path !== localGitPath) projectRootsByPath.set(operation.path, projectRoot);
      }
    }
    return this.prepareRegistrationChange({
      action: "add-scope",
      target: request.target,
      id: request.id,
      operations,
      projectRootsByPath,
      verifyPreview: (mutation) => {
        if (mutation.baseRevisions[current.path] !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `config changed while adding scope: ${current.path}`,
            current.path,
            current.documentRevision,
            mutation.baseRevisions[current.path],
          );
        }
        if (
          localGitPath &&
          localGitRevision &&
          mutation.baseRevisions[localGitPath] !== localGitRevision
        ) {
          throw new MutationConflictError(
            "revision_conflict",
            `Git exclude changed while adding scope: ${localGitPath}`,
            localGitPath,
            localGitRevision,
            mutation.baseRevisions[localGitPath],
          );
        }
      },
      precondition: async () => {
        if ((await realpath(canonicalSource)) !== canonicalSource) {
          throw new MutationConflictError(
            "revision_conflict",
            `skill source changed after preview: ${canonicalSource}`,
          );
        }
        await loadSkillBundle(canonicalSource, request.id);
        if (adoptedCopy) {
          const revision = await validateCopySourceDirectory(adoptedCopy.path);
          if (revision !== adoptedCopy.revision) {
            throw new MutationConflictError(
              "revision_conflict",
              `adopted skill directory changed after preview: ${adoptedCopy.path}`,
              adoptedCopy.path,
              adoptedCopy.revision,
              revision,
            );
          }
        }
      },
    });
  }

  async prepareEdit(
    request: EditSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>> {
    validateRegistrationId(request.id);
    if (
      typeof request.description !== "string" ||
      request.description.trim().length === 0 ||
      !Array.isArray(request.tags) ||
      request.tags.some((tag) => typeof tag !== "string") ||
      typeof request.body !== "string"
    ) {
      throw new SkillRegistrationValidationError(
        "invalid_registration",
        "description, tags, and body must form a valid skill document",
      );
    }
    const current = await this.options.configControlPlane.read(request.target);
    const registration = configuredRegistration(current.document, request.id);
    if (!registration) throw new SkillRegistrationNotFoundError(request.target, request.id);
    if (registration.mode !== "copy") {
      throw new SkillRegistrationValidationError(
        "registration_not_editable",
        `skill registration ${JSON.stringify(request.id)} is a reference and is read-only`,
      );
    }
    const copyPath = await this.ownedCopyPath(request.target, request.id);
    await assertOwnedCopy(copyPath, request.id);
    await this.assertNoReverseReferences(copyPath, request.target, request.id);
    const skillPath = join(copyPath, "SKILL.md");
    const raw = await readFile(skillPath);
    const currentRevision = documentRevision(raw);
    if (request.expectedRevision && request.expectedRevision !== currentRevision) {
      throw new MutationConflictError(
        "revision_conflict",
        `skill changed before preview: ${skillPath}`,
        skillPath,
        request.expectedRevision,
        currentRevision,
      );
    }
    const contents = rewriteSkillDocument(raw.toString("utf8"), {
      description: request.description.trim(),
      tags: request.tags,
      body: stripBundledResourceIndex(request.body),
    });
    try {
      parseSkillMd(contents, skillPath, request.id);
    } catch (error) {
      throw new SkillRegistrationValidationError("invalid_registration", (error as Error).message);
    }
    const operations: MutationInputOperation[] = [
      { kind: "replace-file", path: skillPath, contents },
    ];
    const projectRootsByPath = new Map<string, string>();
    if (request.target.scope !== "user") {
      const project = await this.options.projectRegistry.resolve(request.target.projectId);
      projectRootsByPath.set(skillPath, project.canonicalRoot);
    }
    return this.prepareRegistrationChange({
      action: "edit",
      target: request.target,
      id: request.id,
      operations,
      projectRootsByPath,
      verifyPreview: (mutation) => {
        if (mutation.baseRevisions[skillPath] !== currentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `skill changed while creating preview: ${skillPath}`,
            skillPath,
            currentRevision,
            mutation.baseRevisions[skillPath],
          );
        }
      },
      precondition: async () => {
        const latest = await this.options.configControlPlane.read(request.target);
        if (latest.documentRevision !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `skill registration changed after preview: ${current.path}`,
            current.path,
            current.documentRevision,
            latest.documentRevision,
          );
        }
        await assertOwnedCopy(copyPath, request.id);
        await this.assertNoReverseReferences(copyPath, request.target, request.id);
      },
    });
  }

  async prepareRemove(
    request: RemoveSkillRegistrationRequest,
  ): Promise<PreparedChange<SkillRegistrationReview>> {
    validateRegistrationId(request.id);
    const current = await this.options.configControlPlane.read(request.target);
    const document = { ...current.document } as Record<string, unknown>;
    const rawSkills = document.skills;
    const skills = isPlainObject(rawSkills) ? { ...rawSkills } : {};
    const rawEntries = skills.entries;
    const entries = isPlainObject(rawEntries) ? { ...rawEntries } : {};
    const registration = entries[request.id] as SkillEntry | undefined;
    if (!registration) throw new SkillRegistrationNotFoundError(request.target, request.id);
    delete entries[request.id];
    skills.entries = entries;
    document.skills = skills;
    try {
      parseConfig(document);
    } catch (error) {
      throw new SkillRegistrationValidationError("invalid_registration", (error as Error).message);
    }

    const operations: MutationInputOperation[] = [
      {
        kind: "replace-file",
        path: current.path,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
    ];
    const projectRootsByPath = new Map<string, string>();
    if (request.target.scope !== "user") {
      const project = await this.options.projectRegistry.resolve(request.target.projectId);
      projectRootsByPath.set(current.path, project.canonicalRoot);
    }
    let deletion: { copyPath: string; removedTarget: RatelScopeRef; removedId: string } | undefined;
    if (request.deleteOwnedCopy && registration.mode === "copy") {
      const copyPath = await this.ownedCopyPath(request.target, request.id);
      await assertOwnedCopy(copyPath, request.id);
      await this.assertNoReverseReferences(copyPath, request.target, request.id);
      operations.push({ kind: "delete-artifact", path: copyPath });
      deletion = { copyPath, removedTarget: request.target, removedId: request.id };
      if (request.target.scope !== "user") {
        const project = await this.options.projectRegistry.resolve(request.target.projectId);
        projectRootsByPath.set(copyPath, project.canonicalRoot);
      }
    }
    return this.prepareRegistrationChange({
      action: "remove",
      target: request.target,
      id: request.id,
      operations,
      projectRootsByPath,
      deletion,
      verifyPreview: (mutation) => {
        if (mutation.baseRevisions[current.path] !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `config changed while previewing ${current.path}`,
            current.path,
            current.documentRevision,
            mutation.baseRevisions[current.path],
          );
        }
      },
    });
  }

  commit(changeId: string): Promise<SkillRegistrationCommit> {
    return this.options.preparedChanges.commit(changeId);
  }

  cancel(changeId: string): void {
    this.options.preparedChanges.cancel(changeId);
  }

  async create(request: CreateSkillRegistrationRequest): Promise<SkillRegistrationCommit> {
    const change = await this.prepareCreate(request);
    return this.commit(change.changeId);
  }

  async remove(request: RemoveSkillRegistrationRequest): Promise<SkillRegistrationCommit> {
    const change = await this.prepareRemove(request);
    return this.commit(change.changeId);
  }

  async addScope(request: AddSkillScopeRequest): Promise<SkillRegistrationCommit> {
    const change = await this.prepareAddScope(request);
    return this.commit(change.changeId);
  }

  async edit(request: EditSkillRegistrationRequest): Promise<SkillRegistrationCommit> {
    const change = await this.prepareEdit(request);
    return this.commit(change.changeId);
  }

  private prepareRegistrationChange(input: {
    action: SkillRegistrationReview["action"];
    target: RatelScopeRef;
    id: string;
    operations: readonly MutationInputOperation[];
    projectRootsByPath: ReadonlyMap<string, string>;
    verifyPreview: (mutation: Readonly<PreparedMutation>) => void;
    precondition?: () => Promise<void>;
    deletion?: { copyPath: string; removedTarget: RatelScopeRef; removedId: string };
  }): Promise<PreparedChange<SkillRegistrationReview>> {
    const allowedPaths = new Set(input.operations.map(({ path }) => path));
    return this.options.preparedChanges.prepare({
      kind: `skill.${input.action}`,
      operations: input.operations,
      affectedContexts: [contextForTarget(input.target)],
      buildPreview: (mutation) => {
        input.verifyPreview(mutation);
        return {
          action: input.action,
          target: input.target,
          id: input.id,
          files: mutation.preview.files,
        };
      },
      invariants: {
        precondition: async () => {
          if (input.deletion) {
            await this.assertNoReverseReferences(
              input.deletion.copyPath,
              input.deletion.removedTarget,
              input.deletion.removedId,
            );
          }
          await input.precondition?.();
          for (const [path, projectRoot] of input.projectRootsByPath) {
            await assertSafeProjectControlPath(projectRoot, path);
          }
        },
        operationPrecondition: async (operation) => {
          if (!allowedPaths.has(operation.path)) {
            throw new MutationConflictError(
              "digest_mismatch",
              `skill registration mutation contains an unexpected path: ${operation.path}`,
            );
          }
          if (
            input.deletion &&
            operation.kind === "delete-artifact" &&
            operation.path === input.deletion.copyPath
          ) {
            await assertOwnedCopy(input.deletion.copyPath, input.deletion.removedId);
            await this.assertNoReverseReferences(
              input.deletion.copyPath,
              input.deletion.removedTarget,
              input.deletion.removedId,
            );
          }
          const projectRoot = input.projectRootsByPath.get(operation.path);
          if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
        },
      },
      captureBackup: async () => {
        const backup = startBackup({ homeDir: this.options.homeDir }, nodeFs);
        for (const operation of input.operations) {
          if (operation.kind === "delete-artifact") {
            for (const path of await regularFilesUnder(operation.path)) await backup.capture(path);
          } else {
            await backup.capture(operation.path);
          }
        }
        return backup.finalize(
          input.action === "create" || input.action === "add-scope"
            ? "add"
            : input.action === "remove"
              ? "remove"
              : "edit",
        );
      },
      result: { action: input.action, target: input.target, id: input.id },
    });
  }

  private async ownedCopyPath(target: RatelScopeRef, id: string): Promise<string> {
    validateRegistrationId(id);
    if (target.scope === "user") {
      return derivedOwnedCopyPath(join(this.options.homeDir, ".ratel", "skills"), id);
    }
    const project = await this.options.projectRegistry.resolve(target.projectId);
    const copyRoot =
      target.scope === "project"
        ? join(project.canonicalRoot, ".ratel", "skills")
        : join(project.canonicalRoot, ".ratel", "skills.local");
    const path = derivedOwnedCopyPath(copyRoot, id);
    await assertSafeProjectControlPath(project.canonicalRoot, path);
    return path;
  }

  private async projectRootForTarget(target: RatelScopeRef): Promise<string | undefined> {
    if (target.scope === "user") return undefined;
    const project = await this.options.projectRegistry.resolve(target.projectId);
    try {
      if (!(await stat(project.canonicalRoot)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new SkillRegistrationValidationError(
        "invalid_registration",
        `project root is unavailable: ${project.canonicalRoot}`,
      );
    }
    return project.canonicalRoot;
  }

  private async assertNoReverseReferences(
    copyPath: string,
    removedTarget: RatelScopeRef,
    removedId: string,
  ): Promise<void> {
    const canonicalCopy = await realpath(copyPath);
    const contexts = [
      { kind: "global" as const },
      ...(await this.options.projectRegistry.list())
        .filter(({ status }) => status === "available")
        .map(({ id }) => ({ kind: "project" as const, projectId: id })),
    ];
    for (const context of contexts) {
      const snapshot = await this.options.snapshotResolver.resolve(context);
      for (const registration of snapshot.skills.registrations) {
        if (!registration.canonicalPath) continue;
        if (sameRegistration(registration, removedTarget, removedId)) continue;
        let canonicalRegistration: string;
        try {
          canonicalRegistration = await realpath(registration.canonicalPath);
        } catch {
          continue;
        }
        if (canonicalRegistration === canonicalCopy) {
          throw new SkillRegistrationConflictError(
            "copy_still_referenced",
            `owned copy ${copyPath} is still referenced by ${formatRegistration(registration)}`,
          );
        }
      }
    }
  }
}

function buildSkillDocument(request: CreateSkillRegistrationRequest): string {
  return [
    "---",
    `name: ${JSON.stringify(request.id)}`,
    `description: ${JSON.stringify(request.description.trim())}`,
    ...(request.tags.length > 0
      ? [`tags: [${request.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`]
      : []),
    "---",
    "",
    request.body.trim(),
    "",
  ].join("\n");
}

async function artifactExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function derivedOwnedCopyPath(copyRoot: string, id: string): string {
  const path = join(copyRoot, id);
  if (dirname(path) !== copyRoot) {
    throw new SkillRegistrationValidationError(
      "invalid_registration",
      "owned skill copy must remain directly below its designated copy root",
    );
  }
  return path;
}

function referencePathForTarget(
  target: RatelScopeRef,
  projectRoot: string | undefined,
  canonicalSource: string,
): string {
  if (target.scope === "user") return canonicalSource;
  if (!projectRoot) {
    throw new SkillRegistrationValidationError(
      "invalid_registration",
      `${target.scope} registration requires a project root`,
    );
  }
  const configuredPath = relative(projectRoot, canonicalSource);
  if (
    configuredPath === "" ||
    configuredPath === ".." ||
    configuredPath.startsWith(`..${sep}`) ||
    isAbsolute(configuredPath)
  ) {
    throw new SkillRegistrationValidationError(
      "invalid_registration",
      `${target.scope} references must remain inside the target project root; use copy instead`,
    );
  }
  return configuredPath;
}

function normalizeSkillSource(source: string): SkillSource {
  if (source === "claude" || source === "codex" || source === "ratel") return source;
  return "unknown";
}

function validateRegistrationId(id: string): void {
  if (!isSafeSkillId(id)) {
    throw new SkillRegistrationValidationError(
      "invalid_registration",
      "skill registration id must be a single safe path segment",
    );
  }
}

function configuredRegistration(
  document: Record<string, unknown>,
  id: string,
): SkillEntry | undefined {
  const skills = isPlainObject(document.skills) ? document.skills : undefined;
  const entries = skills && isPlainObject(skills.entries) ? skills.entries : undefined;
  return entries?.[id] as SkillEntry | undefined;
}

async function assertOwnedCopy(path: string, id: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("copy path is not a real directory");
    }
    const markerPath = join(path, ".ratel-skill.json");
    const markerInfo = await lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) {
      throw new Error("ownership marker is not a regular file");
    }
    const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (!isPlainObject(marker) || marker.version !== 1 || marker.id !== id) {
      throw new Error("ownership marker does not match");
    }
  } catch (error) {
    throw new SkillRegistrationValidationError(
      "copy_not_owned",
      `Ratel does not own skill copy ${path}: ${(error as Error).message}`,
    );
  }
}

async function regularFilesUnder(path: string): Promise<string[]> {
  const info = await lstat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory() || info.isSymbolicLink()) return [];
  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFilesUnder(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function sameRegistration(
  registration: SkillRegistrationView,
  target: RatelScopeRef,
  id: string,
): boolean {
  return registration.id === id && sameScope(registration.scopeRef, target);
}

function sameScope(a: RatelScopeRef, b: RatelScopeRef): boolean {
  return (
    a.scope === b.scope &&
    (a.scope === "user" || (b.scope !== "user" && a.projectId === b.projectId))
  );
}

function formatScope(ref: RatelScopeRef): string {
  return ref.scope === "user" ? "user" : `${ref.scope}:${ref.projectId}`;
}

function contextForTarget(target: RatelScopeRef): RuntimeContextRef {
  return target.scope === "user"
    ? { kind: "global" }
    : { kind: "project", projectId: target.projectId };
}

function formatRegistration(registration: SkillRegistrationView): string {
  return `${formatScope(registration.scopeRef)}/${registration.id}/${registration.ref.kind}`;
}
