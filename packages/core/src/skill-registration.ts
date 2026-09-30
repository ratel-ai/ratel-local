import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RatelScopeRef } from "./context.js";
import type { SkillEntry, SkillHostPolicy, SkillSource } from "./lib/config.js";
import { SkillLoadError } from "./lib/skills/load.js";
import { isSafeSkillId } from "./skill-id.js";

export type SkillOrigin = "local-managed" | "reference";

export type SkillAvailability = "available" | "not-found" | "invalid" | "inaccessible";

export function originFromEntry(entry: {
  mode: "reference" | "copy";
  origin?: SkillOrigin;
}): SkillOrigin {
  return entry.origin ?? (entry.mode === "copy" ? "local-managed" : "reference");
}

export interface ConfiguredSkillStoragePathInput {
  homeDir: string;
  projectRoot?: string;
  scopeRef: RatelScopeRef;
  id: string;
  mode: "reference" | "copy";
  path?: string;
}

/** Resolve the on-disk skill directory for a registration. Persisted path wins. */
export function configuredSkillStoragePath(input: ConfiguredSkillStoragePathInput): string {
  if (!isSafeSkillId(input.id)) {
    throw new Error(`unsafe skill registration id: ${JSON.stringify(input.id)}`);
  }
  if (input.path !== undefined) {
    const resolved = resolveConfiguredPath(input, input.path);
    if (input.mode === "copy") assertCopyPathContained(input, resolved);
    return resolved;
  }
  if (input.mode === "copy") {
    return derivedCopyPath(input);
  }
  throw new Error("reference skill registration requires a path");
}

function derivedCopyPath(input: ConfiguredSkillStoragePathInput): string {
  if (input.scopeRef.scope === "user") {
    return join(input.homeDir, ".ratel", "skills", input.id);
  }
  const root = requiredProjectRoot(input);
  return input.scopeRef.scope === "project"
    ? join(root, ".ratel", "skills", input.id)
    : join(root, ".ratel", "skills.local", input.id);
}

function resolveConfiguredPath(input: ConfiguredSkillStoragePathInput, path: string): string {
  if (input.scopeRef.scope !== "user" && isAbsolute(path)) {
    throw new Error(
      `${input.scopeRef.scope} skill ${input.mode} paths must be relative to the project root`,
    );
  }
  if (isAbsolute(path)) return path;
  const base =
    input.scopeRef.scope === "user" ? join(input.homeDir, ".ratel") : requiredProjectRoot(input);
  return resolve(base, path);
}

function assertCopyPathContained(input: ConfiguredSkillStoragePathInput, resolved: string): void {
  const root =
    input.scopeRef.scope === "user" ? join(input.homeDir, ".ratel") : requiredProjectRoot(input);
  const fromRoot = relative(root, resolved);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      input.scopeRef.scope === "user"
        ? "user skill copy path resolves outside ~/.ratel"
        : `${input.scopeRef.scope} skill copy path resolves outside the project root`,
    );
  }
}

function requiredProjectRoot(input: ConfiguredSkillStoragePathInput): string {
  if (!input.projectRoot) {
    throw new Error(`scope ${input.scopeRef.scope} requires a project root`);
  }
  return input.projectRoot;
}

/**
 * Classify a resolve failure into availability. Uses `stat` (follow
 * links) so a dangling symlink is `not-found`, not `invalid`.
 */
export async function availabilityFromResolveFailure(
  error: unknown,
  configuredPath: string,
): Promise<SkillAvailability> {
  if (error instanceof SkillLoadError) return "invalid";

  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return "inaccessible";
  if (code === "ENOTDIR") return "invalid";

  if (code === "ENOENT") {
    try {
      await stat(configuredPath);
      return "invalid";
    } catch (probeError) {
      const probeCode = (probeError as NodeJS.ErrnoException).code;
      if (probeCode === "ENOENT") return "not-found";
      if (probeCode === "EACCES" || probeCode === "EPERM") return "inaccessible";
      return "invalid";
    }
  }

  return "invalid";
}

export interface SkillEntryForWriteInput {
  mode: "reference" | "copy";
  path: string;
  origin?: SkillOrigin;
  source?: SkillSource;
  copiedFrom?: { source: string; id: string };
  hostPolicy?: SkillHostPolicy;
}

/** Persistable entry shape when the skill-storage flag is on. */
export function skillEntryForWrite(input: SkillEntryForWriteInput): SkillEntry {
  const origin = originFromEntry(input);
  if (input.mode === "reference") {
    return {
      mode: "reference",
      origin,
      path: input.path,
      ...(input.source ? { source: input.source } : {}),
      ...(input.hostPolicy ? { hostPolicy: input.hostPolicy } : {}),
    };
  }
  return {
    mode: "copy",
    origin,
    path: input.path,
    ...(input.source ? { source: input.source } : {}),
    ...(input.copiedFrom ? { copiedFrom: input.copiedFrom } : {}),
    ...(input.hostPolicy ? { hostPolicy: input.hostPolicy } : {}),
  };
}

/** Absolute user path, or project-relative path for project/local managed copies. */
export function persistedCopyPathForWrite(
  scopeRef: RatelScopeRef,
  homeDir: string,
  projectRoot: string | undefined,
  id: string,
): string {
  const input: ConfiguredSkillStoragePathInput = {
    homeDir,
    ...(projectRoot ? { projectRoot } : {}),
    scopeRef,
    id,
    mode: "copy",
  };
  const absolute = configuredSkillStoragePath(input);
  return scopeRef.scope === "user" ? absolute : relative(requiredProjectRoot(input), absolute);
}
