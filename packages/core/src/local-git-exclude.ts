import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DocumentRevision } from "./context.js";
import { documentRevision, MISSING_DOCUMENT_REVISION } from "./mutation-engine.js";

export const RATEL_LOCAL_CONFIG_PATH = ".ratel/config.local.json";
export const RATEL_LOCAL_SKILLS_PATH = ".ratel/skills.local";

const BLOCK_BEGIN = "# >>> ratel local scope >>>";
const BLOCK_END = "# <<< ratel local scope <<<";
const BLOCK_LINES = [BLOCK_BEGIN, "/.ratel/config.local.json", "/.ratel/skills.local/", BLOCK_END];

/** The complete canonical block, including its final newline. */
export const RATEL_LOCAL_EXCLUDE_BLOCK = `${BLOCK_LINES.join("\n")}\n`;

export interface LocalGitCommandResult {
  stdout: string;
}

/** Injectable process boundary; arguments are passed directly and never through a shell. */
export interface LocalGitCommandExecutor {
  execFile(command: string, args: readonly string[]): Promise<LocalGitCommandResult>;
}

export interface LocalGitExcludeFs {
  readText(path: string): Promise<string | null>;
  writeTextAtomic(path: string, contents: string): Promise<void>;
}

export interface LocalGitExcludeManagerOptions {
  exec?: LocalGitCommandExecutor;
  fs?: LocalGitExcludeFs;
}

export interface LocalGitExcludeResult {
  projectRoot: string;
  excludePath: string;
  changed: boolean;
}

export interface LocalGitExcludePreview extends LocalGitExcludeResult {
  contents: string;
  currentContents: string | null;
  documentRevision: DocumentRevision;
}

export interface LocalGitExcludeManager {
  preview(projectRoot: string): Promise<LocalGitExcludePreview>;
  ensure(projectRoot: string): Promise<LocalGitExcludeResult>;
}

export type LocalGitExcludeValidationReason =
  | "git_command_failed"
  | "invalid_exclude_file"
  | "invalid_git_path"
  | "invalid_project_root";

/** A local-scope mutation must stop until the user untracks these paths explicitly. */
export class LocalGitTrackedPathError extends Error {
  readonly statusCode = 409;
  readonly code = "LOCAL_GIT_PATHS_TRACKED";
  readonly reason = "local_paths_already_tracked";

  constructor(readonly trackedPaths: string[]) {
    super(
      `local-only Ratel artifacts are already tracked by Git: ${trackedPaths.join(", ")}. ` +
        "Untrack them explicitly before retrying; Ratel will not run git rm --cached.",
    );
    this.name = "LocalGitTrackedPathError";
  }
}

/** Invalid Git/project state maps to 422 for CLI and HTTP control-plane callers. */
export class LocalGitExcludeValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "LOCAL_GIT_EXCLUDE_INVALID";

  constructor(
    readonly reason: LocalGitExcludeValidationReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalGitExcludeValidationError";
  }
}

export const nodeLocalGitCommandExecutor: LocalGitCommandExecutor = {
  execFile(command, args) {
    return new Promise((resolvePromise, reject) => {
      execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise({ stdout });
      });
    });
  },
};

export const nodeLocalGitExcludeFs: LocalGitExcludeFs = {
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async writeTextAtomic(path, contents) {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = join(dirname(path), `.${basename(path)}.ratel-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  },
};

export function createLocalGitExcludeManager(
  options: LocalGitExcludeManagerOptions = {},
): LocalGitExcludeManager {
  return new FilesystemLocalGitExcludeManager(
    options.exec ?? nodeLocalGitCommandExecutor,
    options.fs ?? nodeLocalGitExcludeFs,
  );
}

class FilesystemLocalGitExcludeManager implements LocalGitExcludeManager {
  constructor(
    private readonly exec: LocalGitCommandExecutor,
    private readonly fs: LocalGitExcludeFs,
  ) {}

  async ensure(projectRoot: string): Promise<LocalGitExcludeResult> {
    const preview = await this.preview(projectRoot);
    if (preview.changed) await this.fs.writeTextAtomic(preview.excludePath, preview.contents);
    return {
      projectRoot: preview.projectRoot,
      excludePath: preview.excludePath,
      changed: preview.changed,
    };
  }

  async preview(projectRoot: string): Promise<LocalGitExcludePreview> {
    if (!isAbsolute(projectRoot)) {
      throw new LocalGitExcludeValidationError(
        "invalid_project_root",
        `project root must be absolute: ${projectRoot}`,
      );
    }

    const trackedPaths = await this.findTrackedLocalPaths(projectRoot);
    if (trackedPaths.length > 0) throw new LocalGitTrackedPathError(trackedPaths);

    const excludePath = await this.resolveExcludePath(projectRoot);
    const currentDocument = await this.fs.readText(excludePath);
    const current = currentDocument ?? "";
    const updated = renderExcludeFile(current);
    const changed = current !== updated;
    return {
      projectRoot,
      excludePath,
      changed,
      contents: updated,
      currentContents: currentDocument,
      documentRevision:
        currentDocument === null ? MISSING_DOCUMENT_REVISION : documentRevision(currentDocument),
    };
  }

  private async findTrackedLocalPaths(projectRoot: string): Promise<string[]> {
    const { stdout } = await this.runGit(projectRoot, [
      "ls-files",
      "--",
      RATEL_LOCAL_CONFIG_PATH,
      RATEL_LOCAL_SKILLS_PATH,
    ]);
    return stdout
      .split(/\r?\n/u)
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
      .map((path) => (path.startsWith("/") ? path : `/${path}`));
  }

  private async resolveExcludePath(projectRoot: string): Promise<string> {
    const { stdout } = await this.runGit(projectRoot, ["rev-parse", "--git-path", "info/exclude"]);
    const gitPath = stdout.trim();
    if (gitPath.length === 0 || gitPath.includes("\0") || /[\r\n]/u.test(gitPath)) {
      throw new LocalGitExcludeValidationError(
        "invalid_git_path",
        "git rev-parse returned an invalid info/exclude path",
      );
    }
    return isAbsolute(gitPath) ? gitPath : resolve(projectRoot, gitPath);
  }

  private async runGit(
    projectRoot: string,
    args: readonly string[],
  ): Promise<LocalGitCommandResult> {
    try {
      return await this.exec.execFile("git", ["-C", projectRoot, ...args]);
    } catch (error) {
      throw new LocalGitExcludeValidationError(
        "git_command_failed",
        `unable to inspect Git metadata for ${projectRoot}`,
        { cause: error },
      );
    }
  }
}

function renderExcludeFile(contents: string): string {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const normalized = contents.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();

  const output: string[] = [];
  let insideBlock = false;
  let blockCount = 0;
  for (const line of lines) {
    if (line === BLOCK_BEGIN) {
      if (insideBlock) throw invalidExcludeFile("nested Ratel marker block");
      insideBlock = true;
      blockCount += 1;
      if (blockCount === 1) output.push(...BLOCK_LINES);
      continue;
    }
    if (line === BLOCK_END) {
      if (!insideBlock) throw invalidExcludeFile("closing Ratel marker has no opening marker");
      insideBlock = false;
      continue;
    }
    if (!insideBlock) output.push(line);
  }
  if (insideBlock) throw invalidExcludeFile("Ratel marker block is not closed");
  if (blockCount === 0) output.push(...BLOCK_LINES);

  return `${output.join(newline)}${newline}`;
}

function invalidExcludeFile(detail: string): LocalGitExcludeValidationError {
  return new LocalGitExcludeValidationError(
    "invalid_exclude_file",
    `cannot update Git info/exclude: ${detail}`,
  );
}
