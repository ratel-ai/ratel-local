import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Skill } from "@ratel-ai/sdk";
import type { RatelScopeRef } from "../../context.js";
import { isSafeSkillId } from "../../skill-id.js";
import type { SkillsConfig } from "../config.js";
import { isDirectoryEntry } from "../fs.js";
import { loadSkillBundle } from "./load.js";

export interface SkillScopeConfig {
  ref: RatelScopeRef;
  config?: SkillsConfig;
}

export interface SkillDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  id?: string;
  path?: string;
}

export type SkillRegistrationState = "effective" | "shadowed" | "duplicate" | "invalid";

export interface SkillRegistrationRef {
  scopeRef: RatelScopeRef;
  id: string;
  kind: "entry" | "legacy";
  configuredPath: string;
}

export interface SkillRegistrationView {
  ref: SkillRegistrationRef;
  id: string;
  mode: "reference" | "copy";
  source: string;
  scopeRef: RatelScopeRef;
  configuredPath: string;
  canonicalPath?: string;
  state: SkillRegistrationState;
  editable: boolean;
  shadowedBy?: SkillRegistrationRef;
  duplicateOf?: SkillRegistrationRef;
  diagnostics: SkillDiagnostic[];
}

export interface ResolvedSkillCatalog {
  effectiveSkills: Skill[];
  registrations: SkillRegistrationView[];
  diagnostics: SkillDiagnostic[];
  fingerprint: string;
  watchInputs: string[];
}

export interface ResolveConfiguredSkillsInput {
  homeDir: string;
  projectRoot?: string;
  scopes: SkillScopeConfig[];
}

interface ValidCandidate {
  registration: SkillRegistrationView;
  skill: Skill;
  fingerprintSource: string;
  watchInputs: string[];
  explicit: boolean;
  legacyDirIndex: number;
}

export async function resolveConfiguredSkills(
  input: ResolveConfiguredSkillsInput,
): Promise<ResolvedSkillCatalog> {
  const registrations: SkillRegistrationView[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const candidates: ValidCandidate[] = [];
  const configuredWatchInputs = new Set<string>();

  for (const scoped of input.scopes) {
    for (const [id, entry] of Object.entries(scoped.config?.entries ?? {})) {
      let configuredPath = entry.mode === "reference" ? entry.path : id;
      try {
        if (!isSafeSkillId(id))
          throw new Error(`unsafe skill registration id: ${JSON.stringify(id)}`);
        configuredPath = configuredSkillPath(input, scoped.ref, id, entry);
        const ref: SkillRegistrationRef = {
          scopeRef: scoped.ref,
          id,
          kind: "entry",
          configuredPath,
        };
        const canonicalPath = await realpath(configuredPath);
        if (scoped.ref.scope !== "user") {
          await assertProjectContained(input, scoped.ref, canonicalPath);
        }
        const bundle = await loadSkillBundle(canonicalPath, id);
        const registration: SkillRegistrationView = {
          ref,
          id,
          mode: entry.mode,
          source: entry.source ?? "unknown",
          scopeRef: scoped.ref,
          configuredPath,
          canonicalPath,
          state: "effective",
          editable: entry.mode === "copy" && (await hasMatchingCopyMarker(canonicalPath, id)),
          diagnostics: [],
        };
        registrations.push(registration);
        candidates.push({
          registration,
          fingerprintSource: bundle.fingerprintSource,
          watchInputs:
            entry.mode === "copy"
              ? [...bundle.watchInputs, join(canonicalPath, ".ratel-skill.json")]
              : bundle.watchInputs,
          explicit: true,
          legacyDirIndex: -1,
          skill: bundle.skill,
        });
      } catch (error) {
        const ref: SkillRegistrationRef = {
          scopeRef: scoped.ref,
          id,
          kind: "entry",
          configuredPath,
        };
        const diagnostic: SkillDiagnostic = {
          code: "skill-invalid",
          severity: "error",
          message: (error as Error).message,
          id,
          path: configuredPath,
        };
        diagnostics.push(diagnostic);
        registrations.push({
          ref,
          id,
          mode: entry.mode,
          source: entry.source ?? "unknown",
          scopeRef: scoped.ref,
          configuredPath,
          state: "invalid",
          editable: false,
          diagnostics: [diagnostic],
        });
      }
    }

    for (const [legacyDirIndex, rawDir] of legacySkillDirs(input, scoped).entries()) {
      let configuredDir = rawDir;
      let scanDir = rawDir;
      let entries: Dirent[];
      try {
        configuredDir = await configuredLegacyDirPath(input, scoped.ref, rawDir);
        configuredWatchInputs.add(dirname(configuredDir));
        configuredWatchInputs.add(configuredDir);
        scanDir = await realpath(configuredDir);
        if (scoped.ref.scope !== "user") {
          await assertProjectContained(input, scoped.ref, scanDir);
        }
        configuredWatchInputs.add(dirname(scanDir));
        configuredWatchInputs.add(scanDir);
        entries = await readdir(scanDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          diagnostics.push({
            code: "skill-dir-invalid",
            severity: "error",
            message: (error as Error).message,
            path: configuredDir,
          });
        }
        continue;
      }

      for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
        if (!(await isDirectoryEntry(scanDir, entry))) continue;
        const configuredPath = join(configuredDir, entry.name);
        let id = entry.name;
        const scopeRef = scoped.ref;
        try {
          const canonicalPath = await realpath(join(scanDir, entry.name));
          if (scopeRef.scope !== "user") {
            await assertProjectContained(input, scopeRef, canonicalPath);
          }
          const bundle = await loadSkillBundle(canonicalPath, entry.name);
          id = bundle.skill.id;
          const ref: SkillRegistrationRef = {
            scopeRef,
            id,
            kind: "legacy",
            configuredPath,
          };
          const registration: SkillRegistrationView = {
            ref,
            id,
            mode: "reference",
            source: "unknown",
            scopeRef,
            configuredPath,
            canonicalPath,
            state: "effective",
            editable: false,
            diagnostics: [],
          };
          registrations.push(registration);
          candidates.push({
            registration,
            fingerprintSource: bundle.fingerprintSource,
            watchInputs: bundle.watchInputs,
            explicit: false,
            legacyDirIndex,
            skill: bundle.skill,
          });
        } catch (error) {
          const diagnostic: SkillDiagnostic = {
            code: "skill-invalid",
            severity: "error",
            message: (error as Error).message,
            id,
            path: configuredPath,
          };
          const ref: SkillRegistrationRef = {
            scopeRef,
            id,
            kind: "legacy",
            configuredPath,
          };
          diagnostics.push(diagnostic);
          registrations.push({
            ref,
            id,
            mode: "reference",
            source: "unknown",
            scopeRef,
            configuredPath,
            state: "invalid",
            editable: false,
            diagnostics: [diagnostic],
          });
        }
      }
    }
  }

  const selected: ValidCandidate[] = [];
  const byCanonicalPath = new Map<string, SkillRegistrationRef>();
  const byId = new Map<string, SkillRegistrationRef>();
  for (const candidate of [...candidates].sort(compareCandidatePrecedence)) {
    const canonicalPath = candidate.registration.canonicalPath as string;
    const duplicateOf = byCanonicalPath.get(canonicalPath);
    if (duplicateOf) {
      candidate.registration.state = "duplicate";
      candidate.registration.duplicateOf = duplicateOf;
      continue;
    }
    const shadowedBy = byId.get(candidate.registration.id);
    if (shadowedBy) {
      candidate.registration.state = "shadowed";
      candidate.registration.shadowedBy = shadowedBy;
      byCanonicalPath.set(canonicalPath, shadowedBy);
      continue;
    }
    candidate.registration.state = "effective";
    byCanonicalPath.set(canonicalPath, candidate.registration.ref);
    byId.set(candidate.registration.id, candidate.registration.ref);
    selected.push(candidate);
  }

  selected.sort((a, b) => compareText(a.registration.id, b.registration.id));
  const effectiveSkills = selected.map((candidate) => candidate.skill);
  const fingerprint = createHash("sha256")
    .update(
      selected
        .map(
          ({ registration, fingerprintSource }) =>
            `${registration.id}\0${registration.canonicalPath}\0${fingerprintSource}`,
        )
        .join("\0"),
    )
    .digest("base64url");

  return {
    effectiveSkills,
    registrations,
    diagnostics,
    fingerprint,
    watchInputs: Array.from(
      new Set([
        ...configuredWatchInputs,
        ...candidates.flatMap((candidate) => candidate.watchInputs),
      ]),
    ).sort(compareText),
  };
}

function compareCandidatePrecedence(a: ValidCandidate, b: ValidCandidate): number {
  return (
    scopeRank(b.registration.scopeRef) - scopeRank(a.registration.scopeRef) ||
    Number(b.explicit) - Number(a.explicit) ||
    b.legacyDirIndex - a.legacyDirIndex ||
    compareText(a.registration.configuredPath, b.registration.configuredPath)
  );
}

function scopeRank(ref: RatelScopeRef): number {
  if (ref.scope === "local") return 3;
  if (ref.scope === "project") return 2;
  return 1;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function configuredSkillPath(
  input: ResolveConfiguredSkillsInput,
  ref: RatelScopeRef,
  id: string,
  entry: NonNullable<SkillsConfig["entries"]>[string],
): string {
  if (!isSafeSkillId(id)) throw new Error(`unsafe skill registration id: ${JSON.stringify(id)}`);
  if (entry.mode === "copy") {
    if (ref.scope === "user") return join(input.homeDir, ".ratel", "skills", id);
    const root = requiredProjectRoot(input, ref);
    return ref.scope === "project"
      ? join(root, ".ratel", "skills", id)
      : join(root, ".ratel", "skills.local", id);
  }
  if (ref.scope !== "user" && isAbsolute(entry.path)) {
    throw new Error(`${ref.scope} skill reference paths must be relative to the project root`);
  }
  if (isAbsolute(entry.path)) return entry.path;
  const base =
    ref.scope === "user" ? join(input.homeDir, ".ratel") : requiredProjectRoot(input, ref);
  return resolve(base, entry.path);
}

function requiredProjectRoot(
  input: ResolveConfiguredSkillsInput,
  ref: Exclude<RatelScopeRef, { scope: "user" }>,
): string {
  if (!input.projectRoot) {
    throw new Error(`scope ${ref.scope} requires a project root`);
  }
  return input.projectRoot;
}

function legacySkillDirs(input: ResolveConfiguredSkillsInput, scoped: SkillScopeConfig): string[] {
  if (scoped.config?.dirs !== undefined) return scoped.config.dirs;
  return scoped.ref.scope === "user" ? [join(input.homeDir, ".ratel", "skills")] : [];
}

async function configuredLegacyDirPath(
  input: ResolveConfiguredSkillsInput,
  ref: RatelScopeRef,
  configuredPath: string,
): Promise<string> {
  if (ref.scope !== "user" && isAbsolute(configuredPath)) {
    throw new Error(`${ref.scope} legacy skill dirs must be relative to the project root`);
  }
  if (ref.scope === "user") {
    return isAbsolute(configuredPath)
      ? configuredPath
      : resolve(join(input.homeDir, ".ratel"), configuredPath);
  }
  const canonicalRoot = await realpath(requiredProjectRoot(input, ref));
  const resolvedPath = resolve(canonicalRoot, configuredPath);
  assertContained(ref, canonicalRoot, resolvedPath);
  return resolvedPath;
}

async function assertProjectContained(
  input: ResolveConfiguredSkillsInput,
  ref: Exclude<RatelScopeRef, { scope: "user" }>,
  canonicalPath: string,
): Promise<void> {
  const canonicalRoot = await realpath(requiredProjectRoot(input, ref));
  assertContained(ref, canonicalRoot, canonicalPath);
}

function assertContained(
  ref: Exclude<RatelScopeRef, { scope: "user" }>,
  canonicalRoot: string,
  canonicalPath: string,
): void {
  const fromRoot = relative(canonicalRoot, canonicalPath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${ref.scope} skill path resolves outside the project root`);
  }
}

async function hasMatchingCopyMarker(canonicalPath: string, id: string): Promise<boolean> {
  try {
    const markerPath = join(canonicalPath, ".ratel-skill.json");
    const markerInfo = await lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) return false;
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).version === 1 &&
      (parsed as Record<string, unknown>).id === id
    );
  } catch {
    return false;
  }
}
