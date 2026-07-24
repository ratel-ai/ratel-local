import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { startBackup } from "./backup.js";
import type { DocumentRevision, ProjectId, RatelScopeRef, RuntimeContextRef } from "./context.js";
import { nodeFs } from "./io.js";
import { isPlainObject } from "./json.js";
import {
  ConfigError,
  parseConfig,
  type RatelConfigDocument,
  type RetrievalConfig,
  type ServerEntry,
} from "./lib/config.js";
import type { LocalGitExcludeManager } from "./local-git-exclude.js";
import {
  createMutationEngine,
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  type MutationPreview,
  MutationValidationError,
} from "./mutation-engine.js";
import {
  createPreparedChangeCoordinator,
  type PreparedChange,
  type PreparedChangeCommit,
  type PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";
import { assertSafeProjectControlPath } from "./project-path-safety.js";
import {
  type ProjectContext,
  ProjectNotFoundError,
  type ProjectRegistry,
} from "./project-registry.js";

export type ServerMutationAction = "add" | "edit" | "remove";

export interface ScopedServerMutationRequest {
  target: RatelScopeRef;
  expectedRevision?: DocumentRevision;
  action: ServerMutationAction;
  name: string;
  entry?: ServerEntry;
}

export interface ScopedConfigRead {
  target: RatelScopeRef;
  path: string;
  document: RatelConfigDocument;
  documentRevision: DocumentRevision;
}

export type RetrievalMutationAction = "configure" | "reset";

export interface ScopedRetrievalMutationRequest {
  target: RatelScopeRef;
  expectedRevision?: DocumentRevision;
  action: RetrievalMutationAction;
  retrieval?: RetrievalConfig;
}

export interface ConfigControlPlane {
  read(target: RatelScopeRef): Promise<ScopedConfigRead>;
  prepareServerMutation(
    request: ScopedServerMutationRequest,
  ): Promise<PreparedChange<ServerMutationReview>>;
  prepareRetrievalMutation(
    request: ScopedRetrievalMutationRequest,
  ): Promise<PreparedChange<RetrievalMutationReview>>;
  commit<DomainResult = ServerMutationResult>(
    changeId: string,
  ): Promise<PreparedChangeCommit<DomainResult>>;
  cancel(changeId: string): void;
  mutateServer(
    request: ScopedServerMutationRequest,
  ): Promise<PreparedChangeCommit<ServerMutationResult>>;
  mutateRetrieval(
    request: ScopedRetrievalMutationRequest,
  ): Promise<PreparedChangeCommit<RetrievalMutationResult>>;
}

export interface ServerMutationReview {
  action: ServerMutationAction;
  target: RatelScopeRef;
  name: string;
  files: MutationPreview["files"];
}

export interface ServerMutationResult {
  action: ServerMutationAction;
  target: RatelScopeRef;
  name: string;
}

export interface RetrievalMutationReview {
  action: RetrievalMutationAction;
  target: RatelScopeRef;
  retrieval?: RetrievalConfig;
  files: MutationPreview["files"];
}

export interface RetrievalMutationResult {
  action: RetrievalMutationAction;
  target: RatelScopeRef;
  retrieval?: RetrievalConfig;
}

export interface ConfigControlPlaneOptions {
  homeDir: string;
  projectRegistry: ProjectRegistry;
  preparedChanges?: PreparedChangeCoordinator;
  localGitExcludeManager?: LocalGitExcludeManager;
}

export type ConfigTargetErrorReason = "project_not_found" | "project_missing";

/** A scoped target cannot be resolved to an available, registered project. */
export class ConfigTargetError extends Error {
  readonly code = "CONFIG_TARGET_INVALID";
  readonly statusCode: 404 | 409;

  constructor(
    readonly reason: ConfigTargetErrorReason,
    readonly projectId: ProjectId,
    message: string,
  ) {
    super(message);
    this.name = "ConfigTargetError";
    this.statusCode = reason === "project_not_found" ? 404 : 409;
  }
}

export class ConfigRegistrationError extends Error {
  readonly code = "CONFIG_REGISTRATION_INVALID";

  constructor(
    readonly statusCode: 404 | 409,
    readonly reason: "registration_not_found" | "registration_exists",
    message: string,
  ) {
    super(message);
    this.name = "ConfigRegistrationError";
  }
}

export async function createConfigControlPlane(
  options: ConfigControlPlaneOptions,
): Promise<ConfigControlPlane> {
  const preparedChanges =
    options.preparedChanges ??
    createPreparedChangeCoordinator({
      mutationEngine: await createMutationEngine({ controlDir: join(options.homeDir, ".ratel") }),
    });
  return new FilesystemConfigControlPlane(options, preparedChanges);
}

class FilesystemConfigControlPlane implements ConfigControlPlane {
  constructor(
    private readonly options: ConfigControlPlaneOptions,
    private readonly preparedChanges: PreparedChangeCoordinator,
  ) {}

  async read(target: RatelScopeRef): Promise<ScopedConfigRead> {
    const path = await this.resolveConfigPath(target);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          target,
          path,
          document: {},
          documentRevision: MISSING_DOCUMENT_REVISION,
        };
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new MutationValidationError(
        `invalid JSON in scoped config ${path}: ${errorMessage(error)}`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new MutationValidationError(`scoped config must contain a JSON object: ${path}`);
    }
    try {
      parseConfig(parsed);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new MutationValidationError(`invalid scoped config ${path}: ${error.message}`);
      }
      throw error;
    }
    return {
      target,
      path,
      document: parsed as RatelConfigDocument,
      documentRevision: documentRevision(bytes),
    };
  }

  async prepareServerMutation(
    request: ScopedServerMutationRequest,
  ): Promise<PreparedChange<ServerMutationReview>> {
    validateRequest(request);
    let localGitOperation: { kind: "replace-file"; path: string; contents: string } | undefined;
    let localGitRevision: DocumentRevision | undefined;
    if (request.target.scope === "local" && this.options.localGitExcludeManager) {
      const project = await this.resolveAvailableProject(request.target.projectId);
      const preview = await this.options.localGitExcludeManager.preview(project.canonicalRoot);
      if (preview.changed) {
        localGitOperation = {
          kind: "replace-file",
          path: preview.excludePath,
          contents: preview.contents,
        };
        localGitRevision = preview.documentRevision;
      }
    }
    const current = await this.read(request.target);
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.documentRevision
    ) {
      throw new MutationConflictError(
        "revision_conflict",
        `document changed before preview: ${current.path}`,
        current.path,
        request.expectedRevision,
        current.documentRevision,
      );
    }

    const document: RatelConfigDocument = { ...current.document };
    const servers = { ...(current.document.mcpServers ?? {}) };
    const exists = Object.hasOwn(servers, request.name);
    if (request.action === "add" && exists) {
      throw new ConfigRegistrationError(
        409,
        "registration_exists",
        `MCP server already exists in the selected scope: ${request.name}`,
      );
    }
    if (request.action !== "add" && !exists) {
      throw new ConfigRegistrationError(
        404,
        "registration_not_found",
        `MCP server does not exist in the selected scope: ${request.name}`,
      );
    }

    if (request.action === "remove") {
      delete servers[request.name];
    } else {
      // validateRequest guarantees the entry for add/edit. parseConfig below validates its shape.
      servers[request.name] = request.entry as ServerEntry;
    }
    document.mcpServers = servers;
    try {
      parseConfig(document);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new MutationValidationError(error.message);
      }
      throw error;
    }

    const operations = [
      {
        kind: "replace-file" as const,
        path: current.path,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
      ...(localGitOperation ? [localGitOperation] : []),
    ];
    const projectRootsByPath = new Map<string, string>();
    if (request.target.scope !== "user") {
      const project = await this.resolveAvailableProject(request.target.projectId);
      projectRootsByPath.set(current.path, project.canonicalRoot);
    }
    const allowedPaths = new Set(operations.map(({ path }) => path));
    return this.preparedChanges.prepare({
      kind: `mcp.${request.action}`,
      operations,
      affectedContexts: [contextForTarget(request.target)],
      buildPreview: (mutation) => {
        const previewRevision = mutation.baseRevisions[current.path];
        if (previewRevision !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `document changed while creating preview: ${current.path}`,
            current.path,
            current.documentRevision,
            previewRevision,
          );
        }
        if (
          localGitOperation &&
          localGitRevision !== undefined &&
          mutation.baseRevisions[localGitOperation.path] !== localGitRevision
        ) {
          throw new MutationConflictError(
            "revision_conflict",
            `Git exclude changed while creating preview: ${localGitOperation.path}`,
            localGitOperation.path,
            localGitRevision,
            mutation.baseRevisions[localGitOperation.path],
          );
        }
        return {
          action: request.action,
          target: request.target,
          name: request.name,
          files: mutation.preview.files,
        };
      },
      invariants: {
        precondition: async () => {
          for (const [path, projectRoot] of projectRootsByPath) {
            await assertSafeProjectControlPath(projectRoot, path);
          }
        },
        operationPrecondition: async (operation) => {
          if (!allowedPaths.has(operation.path)) {
            throw new MutationConflictError(
              "digest_mismatch",
              `config mutation contains an unexpected path: ${operation.path}`,
            );
          }
          const projectRoot = projectRootsByPath.get(operation.path);
          if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
        },
      },
      captureBackup: async () => {
        const backup = startBackup({ homeDir: this.options.homeDir }, nodeFs);
        for (const { path } of operations) await backup.capture(path);
        return backup.finalize(request.action);
      },
      result: { action: request.action, target: request.target, name: request.name },
    });
  }

  async mutateServer(
    request: ScopedServerMutationRequest,
  ): Promise<PreparedChangeCommit<ServerMutationResult>> {
    const change = await this.prepareServerMutation(request);
    return this.preparedChanges.commit(change.changeId);
  }

  async prepareRetrievalMutation(
    request: ScopedRetrievalMutationRequest,
  ): Promise<PreparedChange<RetrievalMutationReview>> {
    if (request.action === "configure" && request.retrieval === undefined) {
      throw new MutationValidationError("configure requires a retrieval configuration");
    }
    let localGitOperation: { kind: "replace-file"; path: string; contents: string } | undefined;
    let localGitRevision: DocumentRevision | undefined;
    if (request.target.scope === "local" && this.options.localGitExcludeManager) {
      const project = await this.resolveAvailableProject(request.target.projectId);
      const preview = await this.options.localGitExcludeManager.preview(project.canonicalRoot);
      if (preview.changed) {
        localGitOperation = {
          kind: "replace-file",
          path: preview.excludePath,
          contents: preview.contents,
        };
        localGitRevision = preview.documentRevision;
      }
    }

    const current = await this.read(request.target);
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.documentRevision
    ) {
      throw new MutationConflictError(
        "revision_conflict",
        `document changed before preview: ${current.path}`,
        current.path,
        request.expectedRevision,
        current.documentRevision,
      );
    }

    const document: RatelConfigDocument = { ...current.document };
    if (request.action === "reset") {
      delete document.retrieval;
    } else {
      document.retrieval = request.retrieval;
    }
    try {
      parseConfig(document);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new MutationValidationError(error.message);
      }
      throw error;
    }

    const operations = [
      {
        kind: "replace-file" as const,
        path: current.path,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
      ...(localGitOperation ? [localGitOperation] : []),
    ];
    const projectRootsByPath = new Map<string, string>();
    if (request.target.scope !== "user") {
      const project = await this.resolveAvailableProject(request.target.projectId);
      projectRootsByPath.set(current.path, project.canonicalRoot);
    }
    const allowedPaths = new Set(operations.map(({ path }) => path));
    const result: RetrievalMutationResult = {
      action: request.action,
      target: request.target,
      ...(request.retrieval ? { retrieval: request.retrieval } : {}),
    };
    return this.preparedChanges.prepare({
      kind: `retrieval.${request.action}`,
      operations,
      affectedContexts: [contextForTarget(request.target)],
      buildPreview: (mutation) => {
        const previewRevision = mutation.baseRevisions[current.path];
        if (previewRevision !== current.documentRevision) {
          throw new MutationConflictError(
            "revision_conflict",
            `document changed while creating preview: ${current.path}`,
            current.path,
            current.documentRevision,
            previewRevision,
          );
        }
        if (
          localGitOperation &&
          localGitRevision !== undefined &&
          mutation.baseRevisions[localGitOperation.path] !== localGitRevision
        ) {
          throw new MutationConflictError(
            "revision_conflict",
            `Git exclude changed while creating preview: ${localGitOperation.path}`,
            localGitOperation.path,
            localGitRevision,
            mutation.baseRevisions[localGitOperation.path],
          );
        }
        return {
          ...result,
          files: mutation.preview.files,
        };
      },
      invariants: {
        precondition: async () => {
          for (const [path, projectRoot] of projectRootsByPath) {
            await assertSafeProjectControlPath(projectRoot, path);
          }
        },
        operationPrecondition: async (operation) => {
          if (!allowedPaths.has(operation.path)) {
            throw new MutationConflictError(
              "digest_mismatch",
              `retrieval mutation contains an unexpected path: ${operation.path}`,
            );
          }
          const projectRoot = projectRootsByPath.get(operation.path);
          if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
        },
      },
      captureBackup: async () => {
        const backup = startBackup({ homeDir: this.options.homeDir }, nodeFs);
        for (const { path } of operations) await backup.capture(path);
        return backup.finalize(request.action === "reset" ? "remove" : "edit");
      },
      result,
    });
  }

  async mutateRetrieval(
    request: ScopedRetrievalMutationRequest,
  ): Promise<PreparedChangeCommit<RetrievalMutationResult>> {
    const change = await this.prepareRetrievalMutation(request);
    return this.preparedChanges.commit(change.changeId);
  }

  commit<DomainResult = ServerMutationResult>(
    changeId: string,
  ): Promise<PreparedChangeCommit<DomainResult>> {
    return this.preparedChanges.commit(changeId);
  }

  cancel(changeId: string): void {
    this.preparedChanges.cancel(changeId);
  }

  private async resolveConfigPath(target: RatelScopeRef): Promise<string> {
    if (target.scope === "user") return join(this.options.homeDir, ".ratel", "config.json");
    const project = await this.resolveAvailableProject(target.projectId);
    const path = join(
      project.canonicalRoot,
      ".ratel",
      target.scope === "project" ? "config.json" : "config.local.json",
    );
    await assertSafeProjectControlPath(project.canonicalRoot, path);
    return path;
  }

  private async resolveAvailableProject(projectId: ProjectId): Promise<ProjectContext> {
    let project: ProjectContext;
    try {
      project = await this.options.projectRegistry.resolve(projectId);
    } catch (error) {
      if (error instanceof ProjectNotFoundError) {
        throw new ConfigTargetError(
          "project_not_found",
          projectId,
          `unknown project: ${projectId}`,
        );
      }
      throw error;
    }
    try {
      if (!(await stat(project.canonicalRoot)).isDirectory()) {
        throw new ConfigTargetError(
          "project_missing",
          projectId,
          `project root is unavailable: ${project.canonicalRoot}`,
        );
      }
    } catch (error) {
      if (error instanceof ConfigTargetError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new ConfigTargetError(
          "project_missing",
          projectId,
          `project root is unavailable: ${project.canonicalRoot}`,
        );
      }
      throw error;
    }
    return project;
  }
}

function validateRequest(request: ScopedServerMutationRequest): void {
  if (request.name.trim().length === 0 || request.name.includes("\0")) {
    throw new MutationValidationError("MCP server name must be a non-empty string");
  }
  if (request.action !== "remove" && request.entry === undefined) {
    throw new MutationValidationError(`${request.action} requires an MCP server entry`);
  }
}

function contextForTarget(target: RatelScopeRef): RuntimeContextRef {
  return target.scope === "user"
    ? { kind: "global" }
    : { kind: "project", projectId: target.projectId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
