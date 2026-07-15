import { createHash } from "node:crypto";
import { mkdir, realpath as nodeRealpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { ProjectId } from "./context.js";
import { nodeJsonFs } from "./io.js";
import { isPlainObject } from "./json.js";

export interface StoredProject {
  id: ProjectId;
  canonicalRoot: string;
  displayName: string;
  lastSeenAt: string;
}

export type ProjectContext = StoredProject;

export type ProjectAvailability = "available" | "missing";

export interface ProjectView extends StoredProject {
  status: ProjectAvailability;
}

export interface ProjectRegistry {
  registerRoot(path: string, displayName?: string): Promise<ProjectContext>;
  resolve(id: ProjectId): Promise<ProjectContext>;
  list(): Promise<ProjectView[]>;
  touch(id: ProjectId, at: Date): Promise<void>;
  forget(id: ProjectId): Promise<void>;
}

export interface ProjectsFileV1 {
  version: 1;
  projects: Record<ProjectId, StoredProject>;
}

export interface ProjectRegistryOptions {
  homeDir: string;
  now?: () => Date;
  fs?: ProjectRegistryFs;
}

export interface ProjectRegistryFs {
  read(path: string): Promise<string | null>;
  writeAtomic(path: string, contents: string): Promise<void>;
  realpath(path: string): Promise<string>;
  isDirectory(path: string): Promise<boolean>;
  withLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
}

export class ProjectNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = "PROJECT_NOT_FOUND";

  constructor(readonly projectId: ProjectId) {
    super(`unknown project: ${projectId}`);
    this.name = "ProjectNotFoundError";
  }
}

export class InvalidProjectsFileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`invalid projects file at ${path}: ${reason}`, options);
    this.name = "InvalidProjectsFileError";
  }
}

const LOCK_OPTIONS = {
  realpath: false,
  retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 200 },
  stale: 10_000,
} as const;

export const nodeProjectRegistryFs: ProjectRegistryFs = {
  read: nodeJsonFs.read,
  writeAtomic: nodeJsonFs.writeAtomic,
  realpath: nodeRealpath,
  async isDirectory(path) {
    try {
      return (await stat(path)).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw error;
    }
  },
  async withLock(path, operation) {
    await mkdir(dirname(path), { recursive: true });
    const release = await lockfile.lock(path, LOCK_OPTIONS);
    try {
      return await operation();
    } finally {
      await release();
    }
  },
};

export function projectIdFromCanonicalRoot(canonicalRoot: string): ProjectId {
  const digest = createHash("sha256")
    .update("ratel-project-v1\0")
    .update(canonicalRoot)
    .digest("base64url");
  return `prj_${digest}` as ProjectId;
}

export function projectsFilePath(homeDir: string): string {
  return join(homeDir, ".ratel", "projects.json");
}

export function createProjectRegistry(options: ProjectRegistryOptions): ProjectRegistry {
  return new FilesystemProjectRegistry(options);
}

export class FilesystemProjectRegistry implements ProjectRegistry {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly fs: ProjectRegistryFs;

  constructor(options: ProjectRegistryOptions) {
    this.filePath = projectsFilePath(options.homeDir);
    this.now = options.now ?? (() => new Date());
    this.fs = options.fs ?? nodeProjectRegistryFs;
  }

  async registerRoot(rootPath: string, displayName?: string): Promise<ProjectContext> {
    const canonicalRoot = await this.fs.realpath(rootPath);
    if (!(await this.fs.isDirectory(canonicalRoot))) {
      throw new Error(`project root is not a directory: ${rootPath}`);
    }

    const id = projectIdFromCanonicalRoot(canonicalRoot);
    const lastSeenAt = this.now().toISOString();
    return this.withLock(async () => {
      const file = await this.load();
      const project: StoredProject = {
        id,
        canonicalRoot,
        displayName:
          displayName ??
          file.projects[id]?.displayName ??
          (basename(canonicalRoot) || canonicalRoot),
        lastSeenAt,
      };
      file.projects[id] = project;
      await this.write(file);
      return project;
    });
  }

  async list(): Promise<ProjectView[]> {
    const file = await this.load();
    return Promise.all(
      Object.values(file.projects).map(async (project) => ({
        ...project,
        status: (await this.fs.isDirectory(project.canonicalRoot)) ? "available" : "missing",
      })),
    );
  }

  async resolve(id: ProjectId): Promise<ProjectContext> {
    const project = (await this.load()).projects[id];
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  async touch(id: ProjectId, at: Date): Promise<void> {
    await this.withLock(async () => {
      const file = await this.load();
      const project = file.projects[id];
      if (!project) throw new ProjectNotFoundError(id);
      file.projects[id] = { ...project, lastSeenAt: at.toISOString() };
      await this.write(file);
    });
  }

  async forget(id: ProjectId): Promise<void> {
    await this.withLock(async () => {
      const file = await this.load();
      if (!file.projects[id]) throw new ProjectNotFoundError(id);
      delete file.projects[id];
      await this.write(file);
    });
  }

  private async load(): Promise<ProjectsFileV1> {
    const raw = await this.fs.read(this.filePath);
    if (raw === null) return { version: 1, projects: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidProjectsFileError(this.filePath, "invalid JSON", { cause: error });
    }
    return parseProjectsFile(parsed, this.filePath);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.fs.withLock(this.filePath, operation);
  }

  private async write(file: ProjectsFileV1): Promise<void> {
    await this.fs.writeAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function parseProjectsFile(value: unknown, path: string): ProjectsFileV1 {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.projects)) {
    throw new InvalidProjectsFileError(path, "expected version 1 with a projects object");
  }

  const projects: Record<ProjectId, StoredProject> = {};
  for (const [key, project] of Object.entries(value.projects)) {
    if (
      !isProjectId(key) ||
      !isStoredProject(project) ||
      project.id !== key ||
      projectIdFromCanonicalRoot(project.canonicalRoot) !== key
    ) {
      throw new InvalidProjectsFileError(path, `invalid project record ${JSON.stringify(key)}`);
    }
    projects[key] = project;
  }
  return { version: 1, projects };
}

function isProjectId(value: string): value is ProjectId {
  return /^prj_[A-Za-z0-9_-]{43}$/.test(value);
}

function isStoredProject(value: unknown): value is StoredProject {
  return (
    isPlainObject(value) &&
    typeof value.id === "string" &&
    typeof value.canonicalRoot === "string" &&
    typeof value.displayName === "string" &&
    typeof value.lastSeenAt === "string"
  );
}
