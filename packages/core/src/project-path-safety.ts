import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** A project-scoped control-plane path escaped its registered canonical root. */
export class ProjectPathSafetyError extends Error {
  readonly statusCode = 422;
  readonly code = "PROJECT_PATH_UNSAFE";

  constructor(
    readonly projectRoot: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPathSafetyError";
  }
}

/**
 * Reject lexical escapes and every existing symlink component below a canonical
 * project root. Missing suffixes are safe to create once their nearest existing
 * ancestor has been checked.
 */
export async function assertSafeProjectControlPath(
  projectRoot: string,
  targetPath: string,
): Promise<void> {
  const root = resolve(projectRoot);
  const target = resolve(targetPath);
  let rootInfo: Stats;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    throw unsafe(
      root,
      target,
      `registered project root is unavailable: ${(error as Error).message}`,
    );
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw unsafe(root, target, "registered project root is not a real directory");
  }
  const canonicalRoot = await realpath(root);
  const configuredRelative = relative(root, target);
  if (isOutside(configuredRelative) || !isAbsolute(target)) {
    throw unsafe(root, target, "path is outside the registered project root");
  }

  let current = root;
  for (const segment of configuredRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info: Stats;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw unsafe(root, target, `path contains a symbolic-link component: ${current}`);
    }
    const canonical = await realpath(current);
    if (isOutside(relative(canonicalRoot, canonical))) {
      throw unsafe(root, target, `path component resolves outside the project root: ${current}`);
    }
  }
}

function isOutside(value: string): boolean {
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

function unsafe(root: string, path: string, reason: string): ProjectPathSafetyError {
  return new ProjectPathSafetyError(root, path, `unsafe project control path ${path}: ${reason}`);
}
