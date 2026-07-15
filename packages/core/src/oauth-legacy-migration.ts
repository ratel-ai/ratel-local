import { chmod, link, lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Diagnostic } from "./context-snapshot.js";
import type { OAuthStoreKey, ResolvedMcpEntry } from "./resolved-mcp.js";

export interface LegacyOAuthMigrationInput {
  homeDir: string;
  /**
   * Entries may come from several context snapshots. Repeated inherited user
   * entries are deliberately deduplicated by their complete scoped key.
   */
  entries: readonly ResolvedMcpEntry[];
}

export interface LegacyOAuthMigrationItem {
  serverName: string;
  legacyPath: string;
  target: OAuthStoreKey;
}

export type LegacyOAuthDiagnosticCode =
  | "legacy_oauth_ambiguous"
  | "legacy_oauth_destination_exists"
  | "legacy_oauth_fingerprint_mismatch"
  | "legacy_oauth_invalid"
  | "legacy_oauth_migration_error"
  | "legacy_oauth_stale";

/** A stable, doctor-friendly diagnostic. No diagnostic contains credential data. */
export interface LegacyOAuthMigrationDiagnostic extends Diagnostic {
  code: LegacyOAuthDiagnosticCode;
  path: string;
  serverName: string;
  legacyPath: string;
  message: string;
  requiresReauthentication: boolean;
  targets: OAuthStoreKey[];
  expectedFingerprint?: string;
  actualFingerprint?: string;
}

export interface LegacyOAuthInventory {
  ready: LegacyOAuthMigrationItem[];
  diagnostics: LegacyOAuthMigrationDiagnostic[];
}

export interface LegacyOAuthMigrationReport {
  migrated: LegacyOAuthMigrationItem[];
  diagnostics: LegacyOAuthMigrationDiagnostic[];
}

interface TargetInventory {
  all: OAuthStoreKey[];
  effective: OAuthStoreKey[];
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_OPTIONS = {
  realpath: false,
  retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 200 },
  stale: 10_000,
} as const;

/**
 * Read-only inventory used by doctor and by preview surfaces. Only JSON files
 * directly below the old flat OAuth directory are considered legacy stores.
 */
export async function inventoryLegacyOAuthStores(
  input: LegacyOAuthMigrationInput,
): Promise<LegacyOAuthInventory> {
  return buildInventory(input);
}

/**
 * Move every unambiguous legacy store to its scoped destination.
 *
 * Publication uses a hard link followed by unlinking the legacy name. Hard
 * link creation is atomic and fails with EEXIST, so a concurrently created
 * scoped store is never overwritten. Both paths are protected with the same
 * per-store lock used by RatelOAuthStore.
 */
export async function migrateLegacyOAuthStores(
  input: LegacyOAuthMigrationInput,
): Promise<LegacyOAuthMigrationReport> {
  const oauthDir = legacyOAuthDirectory(input.homeDir);
  await mkdir(oauthDir, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(oauthDir, DIRECTORY_MODE).catch(() => undefined);

  return withMigrationLock(oauthDir, async () => {
    const initial = await buildInventory(input);
    const migrated: LegacyOAuthMigrationItem[] = [];
    const diagnostics = [...initial.diagnostics];
    const targets = indexTargets(input.entries);

    for (const item of initial.ready) {
      await mkdir(dirname(item.target.path), { recursive: true, mode: DIRECTORY_MODE });
      await chmod(dirname(item.target.path), DIRECTORY_MODE).catch(() => undefined);

      await withStoreLock(item.legacyPath, async () => {
        await withStoreLock(item.target.path, async () => {
          // Reconcile after both locks: preview/doctor output is never trusted
          // as an authorization to move bytes that have since changed.
          const current = await analyzeLegacyFile(item.legacyPath, item.serverName, targets);
          if (current.kind === "diagnostic") {
            diagnostics.push(current.diagnostic);
            return;
          }

          try {
            await link(item.legacyPath, current.item.target.path);
          } catch (error) {
            if (isNodeError(error, "EEXIST")) {
              diagnostics.push(destinationExistsDiagnostic(current.item));
              return;
            }
            diagnostics.push(migrationErrorDiagnostic(current.item, error));
            return;
          }

          try {
            // link() preserves the legacy inode's mode; normalize it before
            // publishing the scoped name as the only remaining link.
            await chmod(current.item.target.path, FILE_MODE);
            await unlink(item.legacyPath);
          } catch (error) {
            // The source is retained when unlink fails. Remove the just-created
            // destination so the failed migration cannot affect runtime state.
            await unlink(current.item.target.path).catch(() => undefined);
            diagnostics.push(migrationErrorDiagnostic(current.item, error));
            return;
          }
          migrated.push(current.item);
        });
      });
    }

    return {
      migrated: migrated.sort(compareItems),
      diagnostics: deduplicateDiagnostics(diagnostics).sort(compareDiagnostics),
    };
  });
}

function legacyOAuthDirectory(homeDir: string): string {
  return join(homeDir, ".ratel", "oauth");
}

async function buildInventory(input: LegacyOAuthMigrationInput): Promise<LegacyOAuthInventory> {
  const oauthDir = legacyOAuthDirectory(input.homeDir);
  const names = await legacyStoreNames(oauthDir);
  const targets = indexTargets(input.entries);
  const ready: LegacyOAuthMigrationItem[] = [];
  const diagnostics: LegacyOAuthMigrationDiagnostic[] = [];

  for (const serverName of names) {
    const legacyPath = join(oauthDir, `${serverName}.json`);
    const result = await analyzeLegacyFile(legacyPath, serverName, targets);
    if (result.kind === "ready") ready.push(result.item);
    else diagnostics.push(result.diagnostic);
  }

  return {
    ready: ready.sort(compareItems),
    diagnostics: diagnostics.sort(compareDiagnostics),
  };
}

async function legacyStoreNames(oauthDir: string): Promise<string[]> {
  try {
    return (await readdir(oauthDir, { withFileTypes: true }))
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort(compareText);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

function indexTargets(entries: readonly ResolvedMcpEntry[]): Map<string, TargetInventory> {
  const byName = new Map<
    string,
    { all: Map<string, OAuthStoreKey>; effective: Map<string, OAuthStoreKey> }
  >();
  for (const entry of entries) {
    if (entry.entry.type !== "http" && entry.entry.type !== "sse") continue;
    if (entry.status === "invalid") continue;
    let group = byName.get(entry.name);
    if (!group) {
      group = { all: new Map(), effective: new Map() };
      byName.set(entry.name, group);
    }
    const identity = targetIdentity(entry.oauthKey);
    group.all.set(identity, entry.oauthKey);
    if (entry.status === "effective") group.effective.set(identity, entry.oauthKey);
  }
  return new Map(
    [...byName].map(([name, group]) => [
      name,
      {
        all: [...group.all.values()].sort(compareTargets),
        effective: [...group.effective.values()].sort(compareTargets),
      },
    ]),
  );
}

type LegacyAnalysis =
  | { kind: "ready"; item: LegacyOAuthMigrationItem }
  | { kind: "diagnostic"; diagnostic: LegacyOAuthMigrationDiagnostic };

async function analyzeLegacyFile(
  legacyPath: string,
  serverName: string,
  targetsByName: Map<string, TargetInventory>,
): Promise<LegacyAnalysis> {
  const inventory = targetsByName.get(serverName) ?? { all: [], effective: [] };
  if (inventory.effective.length === 0) {
    return {
      kind: "diagnostic",
      diagnostic: {
        code: "legacy_oauth_stale",
        severity: "warning",
        path: legacyPath,
        serverName,
        legacyPath,
        message: `Legacy OAuth state for ${serverName} has no effective scoped server`,
        requiresReauthentication: true,
        targets: inventory.all,
      },
    };
  }
  // Shadowed registrations are still plausible owners of the historical flat
  // file. A single effective row therefore does not make an override safe.
  if (inventory.all.length !== 1) {
    return {
      kind: "diagnostic",
      diagnostic: {
        code: "legacy_oauth_ambiguous",
        severity: "error",
        path: legacyPath,
        serverName,
        legacyPath,
        message: `Legacy OAuth state for ${serverName} maps to ${inventory.all.length} scoped owners`,
        requiresReauthentication: true,
        targets: inventory.all,
      },
    };
  }

  const target = inventory.all[0] as OAuthStoreKey;
  const item = { serverName, legacyPath, target };
  let state: ReadState;
  try {
    state = await readState(legacyPath);
  } catch (error) {
    return { kind: "diagnostic", diagnostic: migrationErrorDiagnostic(item, error) };
  }
  if (state.kind !== "valid") {
    return {
      kind: "diagnostic",
      diagnostic: {
        code: "legacy_oauth_invalid",
        severity: "error",
        path: legacyPath,
        serverName,
        legacyPath,
        message: `Legacy OAuth state for ${serverName} is not a valid store`,
        requiresReauthentication: true,
        targets: [target],
      },
    };
  }
  if (state.fingerprint && state.fingerprint !== target.fingerprint) {
    return {
      kind: "diagnostic",
      diagnostic: {
        code: "legacy_oauth_fingerprint_mismatch",
        severity: "error",
        path: legacyPath,
        serverName,
        legacyPath,
        message: `Legacy OAuth state for ${serverName} belongs to a different resource`,
        requiresReauthentication: true,
        targets: [target],
        expectedFingerprint: target.fingerprint,
        actualFingerprint: state.fingerprint,
      },
    };
  }

  let destinationState: ReadState;
  try {
    destinationState = await readState(target.path);
  } catch (error) {
    return { kind: "diagnostic", diagnostic: migrationErrorDiagnostic(item, error) };
  }
  if (destinationState.kind !== "missing") {
    if (
      destinationState.kind === "valid" &&
      destinationState.fingerprint &&
      destinationState.fingerprint !== target.fingerprint
    ) {
      return {
        kind: "diagnostic",
        diagnostic: {
          code: "legacy_oauth_fingerprint_mismatch",
          severity: "error",
          path: target.path,
          serverName,
          legacyPath,
          message: `Scoped OAuth state for ${serverName} belongs to a different resource`,
          requiresReauthentication: true,
          targets: [target],
          expectedFingerprint: target.fingerprint,
          actualFingerprint: destinationState.fingerprint,
        },
      };
    }
    return { kind: "diagnostic", diagnostic: destinationExistsDiagnostic(item) };
  }

  return { kind: "ready", item };
}

type ReadState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; fingerprint?: string };

async function readState(path: string): Promise<ReadState> {
  try {
    const file = await lstat(path);
    if (!file.isFile()) return { kind: "invalid" };
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "invalid" };
    }
    const fingerprint = (parsed as { resource_fingerprint?: unknown }).resource_fingerprint;
    if (fingerprint !== undefined && typeof fingerprint !== "string") {
      return { kind: "invalid" };
    }
    return { kind: "valid", ...(fingerprint ? { fingerprint } : {}) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { kind: "missing" };
    if (error instanceof SyntaxError) return { kind: "invalid" };
    throw error;
  }
}

function destinationExistsDiagnostic(
  item: LegacyOAuthMigrationItem,
): LegacyOAuthMigrationDiagnostic {
  return {
    code: "legacy_oauth_destination_exists",
    severity: "warning",
    path: item.target.path,
    serverName: item.serverName,
    legacyPath: item.legacyPath,
    message: `Scoped OAuth state already exists for ${item.serverName}; legacy state was retained`,
    requiresReauthentication: false,
    targets: [item.target],
  };
}

function migrationErrorDiagnostic(
  item: LegacyOAuthMigrationItem,
  error: unknown,
): LegacyOAuthMigrationDiagnostic {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    code: "legacy_oauth_migration_error",
    severity: "error",
    path: item.legacyPath,
    serverName: item.serverName,
    legacyPath: item.legacyPath,
    message: `Could not migrate OAuth state for ${item.serverName}: ${detail}`,
    requiresReauthentication: true,
    targets: [item.target],
  };
}

async function withMigrationLock<T>(oauthDir: string, operation: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(oauthDir, {
    ...LOCK_OPTIONS,
    lockfilePath: join(oauthDir, ".legacy-migration.lock"),
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function withStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(path, LOCK_OPTIONS);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function targetIdentity(target: OAuthStoreKey): string {
  return `${target.path}\0${target.fingerprint}`;
}

function deduplicateDiagnostics(
  diagnostics: readonly LegacyOAuthMigrationDiagnostic[],
): LegacyOAuthMigrationDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}\0${diagnostic.legacyPath}\0${diagnostic.expectedFingerprint ?? ""}\0${diagnostic.actualFingerprint ?? ""}`,
        diagnostic,
      ]),
    ).values(),
  ];
}

function compareItems(a: LegacyOAuthMigrationItem, b: LegacyOAuthMigrationItem): number {
  return compareText(a.serverName, b.serverName) || compareText(a.target.path, b.target.path);
}

function compareDiagnostics(
  a: LegacyOAuthMigrationDiagnostic,
  b: LegacyOAuthMigrationDiagnostic,
): number {
  return compareText(a.serverName, b.serverName) || compareText(a.code, b.code);
}

function compareTargets(a: OAuthStoreKey, b: OAuthStoreKey): number {
  return compareText(a.path, b.path) || compareText(a.fingerprint, b.fingerprint);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
