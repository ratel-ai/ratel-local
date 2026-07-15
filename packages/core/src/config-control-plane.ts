import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentRevision, ProjectId, RatelScopeRef } from "./context.js";
import { isPlainObject } from "./json.js";
import {
  ConfigError,
  parseConfig,
  type RatelConfigDocument,
  type ServerEntry,
} from "./lib/config.js";
import type { LocalGitExcludeManager } from "./local-git-exclude.js";
import {
  createMutationEngine,
  documentRevision,
  MISSING_DOCUMENT_REVISION,
  type MutationCommit,
  MutationConflictError,
  type MutationEngine,
  type MutationPlan,
  MutationValidationError,
} from "./mutation-engine.js";
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

export interface ConfigControlPlane {
  read(target: RatelScopeRef): Promise<ScopedConfigRead>;
  previewServerMutation(request: ScopedServerMutationRequest): Promise<MutationPlan>;
  apply(plan: MutationPlan, options: { digest: string }): Promise<MutationCommit>;
  mutateServer(request: ScopedServerMutationRequest): Promise<MutationCommit>;
}

export interface ConfigControlPlaneOptions {
  homeDir: string;
  projectRegistry: ProjectRegistry;
  mutationEngine?: MutationEngine;
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
  const mutationEngine =
    options.mutationEngine ??
    (await createMutationEngine({ controlDir: join(options.homeDir, ".ratel") }));
  return new FilesystemConfigControlPlane(options, mutationEngine);
}

class FilesystemConfigControlPlane implements ConfigControlPlane {
  private readonly pendingPlans = new Map<
    string,
    {
      allowedPaths: Set<string>;
      projectRootsByPath: Map<string, string>;
      serializedPlan: string;
    }
  >();

  constructor(
    private readonly options: ConfigControlPlaneOptions,
    private readonly mutationEngine: MutationEngine,
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

  async previewServerMutation(request: ScopedServerMutationRequest): Promise<MutationPlan> {
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

    const plan = await this.mutationEngine.preview([
      {
        kind: "replace-file",
        path: current.path,
        contents: `${JSON.stringify(document, null, 2)}\n`,
      },
      ...(localGitOperation ? [localGitOperation] : []),
    ]);
    const previewRevision = plan.baseRevisions[current.path];
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
      plan.baseRevisions[localGitOperation.path] !== localGitRevision
    ) {
      throw new MutationConflictError(
        "revision_conflict",
        `Git exclude changed while creating preview: ${localGitOperation.path}`,
        localGitOperation.path,
        localGitRevision,
        plan.baseRevisions[localGitOperation.path],
      );
    }
    const projectRootsByPath = new Map<string, string>();
    if (request.target.scope !== "user") {
      const project = await this.resolveAvailableProject(request.target.projectId);
      projectRootsByPath.set(current.path, project.canonicalRoot);
    }
    this.pendingPlans.set(plan.id, {
      allowedPaths: new Set(plan.operations.map(({ path }) => path)),
      projectRootsByPath,
      serializedPlan: JSON.stringify(plan),
    });
    return plan;
  }

  apply(plan: MutationPlan, options: { digest: string }): Promise<MutationCommit> {
    const pending = this.pendingPlans.get(plan.id);
    this.pendingPlans.delete(plan.id);
    if (!pending) {
      throw new MutationConflictError(
        "digest_mismatch",
        "config mutation preview is unknown, expired, or already consumed",
      );
    }
    if (JSON.stringify(plan) !== pending.serializedPlan) {
      throw new MutationConflictError(
        "digest_mismatch",
        "config mutation preview was modified after it was issued",
      );
    }
    return this.mutationEngine.apply(plan, {
      ...options,
      precondition: async () => {
        for (const [path, projectRoot] of pending.projectRootsByPath) {
          await assertSafeProjectControlPath(projectRoot, path);
        }
      },
      operationPrecondition: async (operation) => {
        if (!pending.allowedPaths.has(operation.path)) {
          throw new MutationConflictError(
            "digest_mismatch",
            `config mutation contains an unexpected path: ${operation.path}`,
          );
        }
        const projectRoot = pending.projectRootsByPath.get(operation.path);
        if (projectRoot) await assertSafeProjectControlPath(projectRoot, operation.path);
      },
    });
  }

  async mutateServer(request: ScopedServerMutationRequest): Promise<MutationCommit> {
    const plan = await this.previewServerMutation(request);
    return this.apply(plan, { digest: plan.digest });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
