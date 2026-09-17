import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RatelScopeRef } from "./context.js";
import type { SkillEntry, SkillHostPolicy, SkillSource } from "./lib/config.js";
import { SkillLoadError } from "./lib/skills/load.js";
import { isSafeSkillId } from "./skill-id.js";

export type SkillOrigin = "local-managed" | "reference" | "cloud-managed" | "cloud-detached";

export type SkillStorageKind = "managed-copy" | "external" | "cloud-replica";

export interface SkillStorage {
  kind: SkillStorageKind;
  path: string;
}

export type SkillAvailability = "available" | "not-found" | "invalid" | "inaccessible";

export type SkillSyncState = "synced" | "conflict" | "disabled";

export function isSkillOrigin(value: unknown): value is SkillOrigin {
  return (
    value === "local-managed" ||
    value === "reference" ||
    value === "cloud-managed" ||
    value === "cloud-detached"
  );
}

export function originFromMode(mode: "reference" | "copy"): SkillOrigin {
  return mode === "copy" ? "local-managed" : "reference";
}

export function originFromEntry(entry: {
  mode: "reference" | "copy";
  origin?: SkillOrigin;
}): SkillOrigin {
  return entry.origin ?? originFromMode(entry.mode);
}

export function storageKindFromOrigin(origin: SkillOrigin): SkillStorageKind {
  switch (origin) {
    case "local-managed":
      return "managed-copy";
    case "reference":
      return "external";
    case "cloud-managed":
    case "cloud-detached":
      return "cloud-replica";
  }
}

export function skillStorageFrom(origin: SkillOrigin, path: string): SkillStorage {
  return { kind: storageKindFromOrigin(origin), path };
}

export function syncFromOrigin(origin: SkillOrigin): SkillSyncState | undefined {
  return origin === "cloud-detached" ? "disabled" : undefined;
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
    return resolveConfiguredPath(input, input.path);
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
      `${input.scopeRef.scope} skill reference paths must be relative to the project root`,
    );
  }
  if (isAbsolute(path)) return path;
  const base =
    input.scopeRef.scope === "user" ? join(input.homeDir, ".ratel") : requiredProjectRoot(input);
  return resolve(base, path);
}

function requiredProjectRoot(input: ConfiguredSkillStoragePathInput): string {
  if (!input.projectRoot) {
    throw new Error(`scope ${input.scopeRef.scope} requires a project root`);
  }
  return input.projectRoot;
}

/**
 * Classify a resolve failure into availability. Uses `stat`/`realpath` (follow
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
  const origin = input.origin ?? originFromMode(input.mode);
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
  const absolute = configuredSkillStoragePath({
    homeDir,
    ...(projectRoot ? { projectRoot } : {}),
    scopeRef,
    id,
    mode: "copy",
  });
  if (scopeRef.scope === "user") return absolute;
  if (!projectRoot) {
    throw new Error(`scope ${scopeRef.scope} requires a project root`);
  }
  const relativePath = relative(projectRoot, absolute);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`${scopeRef.scope} skill copy path resolves outside the project root`);
  }
  return relativePath;
}
