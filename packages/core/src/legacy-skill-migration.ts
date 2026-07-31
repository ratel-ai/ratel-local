import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { startBackup } from "./backup.js";
import type { ConfigControlPlane } from "./config-control-plane.js";
import { nodeFs } from "./io.js";
import { isPlainObject } from "./json.js";
import { parseConfig, type SkillEntry } from "./lib/config.js";
import type { MutationInputOperation, MutationPreview } from "./mutation-engine.js";
import type {
  PreparedChange,
  PreparedChangeCommit,
  PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";
import { type NativeSkillSource, skillHostPolicyFromLegacyPatch } from "./skill-host-policy.js";
import { isSafeSkillId } from "./skill-id.js";

interface LegacyMetadataPatch {
  path: string;
  before?: string;
  after: string;
  created?: boolean;
}

interface LegacyManagedEntry {
  id: string;
  mode?: "linked";
  originalPath: string;
  source?: "claude" | "codex";
  metadataPatch?: LegacyMetadataPatch[];
}

interface LegacyManifest {
  version: 1;
  managed: unknown[];
}

export interface LegacySkillMigrationDiagnostic {
  id: string;
  code:
    | "legacy_skill_conflict"
    | "legacy_skill_invalid"
    | "legacy_skill_metadata_changed"
    | "legacy_skill_not_linked";
  message: string;
}

export interface LegacySkillMigrationResult {
  migrated: string[];
  diagnostics: LegacySkillMigrationDiagnostic[];
}

export interface LegacySkillMigrationReview extends LegacySkillMigrationResult {
  files: MutationPreview["files"];
}

export type LegacySkillMigrationCommit = PreparedChangeCommit<LegacySkillMigrationResult>;

export async function prepareLegacySkillMigration(options: {
  homeDir: string;
  configControlPlane: ConfigControlPlane;
  preparedChanges: PreparedChangeCoordinator;
}): Promise<PreparedChange<LegacySkillMigrationReview> | null> {
  const manifestPath = join(options.homeDir, ".ratel", "skill-manifest.json");
  const manifest = await readLegacyManifest(manifestPath);
  if (!manifest) return null;

  const current = await options.configControlPlane.read({ scope: "user" });
  const document = { ...current.document } as Record<string, unknown>;
  const skills = isPlainObject(document.skills) ? { ...document.skills } : {};
  const entries = isPlainObject(skills.entries) ? { ...skills.entries } : {};
  const remaining: unknown[] = [];
  const migrated: string[] = [];
  const diagnostics: LegacySkillMigrationDiagnostic[] = [];
  const operations: MutationInputOperation[] = [];

  for (const raw of manifest.managed) {
    const entry = parseLegacyEntry(raw);
    if (!entry) {
      remaining.push(raw);
      diagnostics.push({
        id: legacyId(raw),
        code: "legacy_skill_invalid",
        message: "legacy manifest entry is malformed or uses the pre-link move format",
      });
      continue;
    }
    if (Object.hasOwn(entries, entry.id)) {
      remaining.push(raw);
      diagnostics.push({
        id: entry.id,
        code: "legacy_skill_conflict",
        message: "a user-scoped registration already exists",
      });
      continue;
    }
    const source = detailedSource(entry);
    const nativePath = nativeSkillPath(options.homeDir, entry.id, source);
    const linkPath = join(options.homeDir, ".ratel", "skills", entry.id);
    const metadataPatch = entry.metadataPatch?.[0];
    try {
      const expectedMetadataPath =
        source === "claude"
          ? join(nativePath, "SKILL.md")
          : join(nativePath, "agents", "openai.yaml");
      if (!metadataPatch || metadataPatch.path !== expectedMetadataPath) {
        throw new Error("recorded metadata patch does not target the native skill policy");
      }
      const linkInfo = await lstat(linkPath);
      if (
        !linkInfo.isSymbolicLink() ||
        (await realpath(linkPath)) !== (await realpath(nativePath))
      ) {
        throw new Error("managed path is not the recorded native-skill symlink");
      }
      if ((await readFile(metadataPatch.path, "utf8")) !== metadataPatch.after) {
        remaining.push(raw);
        diagnostics.push({
          id: entry.id,
          code: "legacy_skill_metadata_changed",
          message: "native invocation metadata changed after legacy management",
        });
        continue;
      }
      if ((await realpath(entry.originalPath)) !== (await realpath(nativePath))) {
        throw new Error("recorded original path does not match the native skill");
      }
      entries[entry.id] = {
        mode: "reference",
        path: await realpath(nativePath),
        source: source === "claude" ? "claude" : "codex",
        hostPolicy: skillHostPolicyFromLegacyPatch({
          source,
          before: metadataPatch.before,
          created: metadataPatch.created,
        }),
      } satisfies SkillEntry;
      operations.push({
        kind: "delete-artifact",
        path: linkPath,
        expectedSymlinkTarget: await realpath(nativePath),
      });
      migrated.push(entry.id);
    } catch (error) {
      remaining.push(raw);
      diagnostics.push({
        id: entry.id,
        code: "legacy_skill_not_linked",
        message: (error as Error).message,
      });
    }
  }
  if (migrated.length === 0) return null;

  skills.entries = entries;
  document.skills = skills;
  parseConfig(document);
  operations.unshift({
    kind: "replace-file",
    path: current.path,
    contents: `${JSON.stringify(document, null, 2)}\n`,
  });
  if (remaining.length === 0) {
    operations.push({ kind: "delete-artifact", path: manifestPath });
  } else {
    operations.push({
      kind: "replace-file",
      path: manifestPath,
      contents: `${JSON.stringify({ version: 1, managed: remaining }, null, 2)}\n`,
    });
  }

  return options.preparedChanges.prepare({
    kind: "skill.legacy-migration",
    operations,
    affectedContexts: [{ kind: "global" }],
    buildPreview: (mutation) => ({
      migrated,
      diagnostics,
      files: mutation.preview.files,
    }),
    captureBackup: async () => {
      const backup = startBackup({ homeDir: options.homeDir }, nodeFs);
      await backup.capture(current.path);
      await backup.capture(manifestPath);
      return backup.finalize("import");
    },
    result: { migrated, diagnostics },
  });
}

export async function migrateLegacySkillLinks(options: {
  homeDir: string;
  configControlPlane: ConfigControlPlane;
  preparedChanges: PreparedChangeCoordinator;
}): Promise<LegacySkillMigrationCommit | null> {
  const change = await prepareLegacySkillMigration(options);
  return change ? options.preparedChanges.commit(change.changeId) : null;
}

async function readLegacyManifest(path: string): Promise<LegacyManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.managed)) {
      return { version: 1, managed: [value] };
    }
    return { version: 1, managed: value.managed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { version: 1, managed: [{ unreadable: (error as Error).message }] };
  }
}

function parseLegacyEntry(raw: unknown): LegacyManagedEntry | null {
  if (
    !isPlainObject(raw) ||
    typeof raw.id !== "string" ||
    !isSafeSkillId(raw.id) ||
    raw.mode !== "linked" ||
    typeof raw.originalPath !== "string" ||
    (raw.source !== undefined && raw.source !== "claude" && raw.source !== "codex") ||
    !Array.isArray(raw.metadataPatch) ||
    raw.metadataPatch.length !== 1
  ) {
    return null;
  }
  const patches = raw.metadataPatch.filter(
    (patch): patch is LegacyMetadataPatch =>
      isPlainObject(patch) &&
      typeof patch.path === "string" &&
      typeof patch.after === "string" &&
      (patch.before === undefined || typeof patch.before === "string") &&
      (patch.created === undefined || typeof patch.created === "boolean"),
  );
  if (patches.length !== raw.metadataPatch.length) return null;
  return {
    id: raw.id,
    mode: "linked",
    originalPath: raw.originalPath,
    ...(raw.source ? { source: raw.source } : {}),
    metadataPatch: patches,
  };
}

function detailedSource(entry: LegacyManagedEntry): NativeSkillSource {
  return entry.source === "codex" ? "codex-legacy" : "claude";
}

function nativeSkillPath(homeDir: string, id: string, source: NativeSkillSource): string {
  return source === "claude"
    ? join(homeDir, ".claude", "skills", id)
    : source === "codex-current"
      ? join(homeDir, ".agents", "skills", id)
      : join(homeDir, ".codex", "skills", id);
}

function legacyId(raw: unknown): string {
  return isPlainObject(raw) && typeof raw.id === "string" ? raw.id : "unknown";
}
