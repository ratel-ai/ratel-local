import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloudOtlpTraceRelayOptions } from "./otlp-trace-relay.js";

export const DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT = "https://cloud.ratel.sh/api/v1/traces";

/** One stored credential. A profile holds a key; the deployment is shared. */
export interface CloudProfile {
  apiKey: string;
}

/**
 * The Cloud credential store (ADR-0021). User level only: it holds secrets, so
 * it has no project-scope counterpart. Which profile a project uses is selected
 * from layered configuration, which carries a name and never a key.
 */
export interface CloudSettings {
  /** The deployment every profile talks to. Logs and catalog derive from it. */
  tracesEndpoint: string;
  /** Profile used when nothing selects one. */
  default?: string;
  profiles: Record<string, CloudProfile>;
}

export interface CloudSettingsStoreLike {
  load(): Promise<CloudSettings | undefined>;
  save(settings: CloudSettings): Promise<void>;
}

/** A credential resolved for one context, with where the choice came from. */
export interface ResolvedCloudCredential {
  apiKey: string;
  tracesEndpoint: string;
  /** Profile name, or `undefined` when the environment supplied the key. */
  profile?: string;
  /** Human-readable origin of the selection, for `traces status`. */
  source: string;
}

export class CloudProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudProfileError";
  }
}

export function cloudSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud.json");
}

/** Pre-ADR-0021 store: a single flat `{endpoint, apiKey}`. Read, never written. */
export function legacyCloudSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud-traces.json");
}

export const MIGRATED_PROFILE_NAME = "default";

export class CloudSettingsStore implements CloudSettingsStoreLike {
  constructor(
    private readonly path: string,
    private readonly legacyPath?: string,
  ) {}

  async load(): Promise<CloudSettings | undefined> {
    const current = await readJsonFile(this.path);
    if (current !== undefined) return validated(parseSettings(current));
    if (!this.legacyPath) return undefined;
    const legacy = await readJsonFile(this.legacyPath);
    return legacy === undefined ? undefined : validated(migrateLegacy(legacy));
  }

  async save(settings: CloudSettings): Promise<void> {
    const next = validated(settings);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

/**
 * Pick the credential for one context. `selection` is the profile a scope asked
 * for and where it asked from; a name the store does not define is an error
 * naming both, never a quiet fall back to the default — that is how one
 * project's telemetry reaches another project's Cloud account.
 */
export function resolveCloudCredential(
  settings: CloudSettings,
  selection: { profile?: string; source: string } = { source: "default" },
): ResolvedCloudCredential {
  const name = selection.profile ?? settings.default;
  if (!name) {
    throw new CloudProfileError(
      "no Cloud profile is selected and the store has no default; add one with `ratel-local cloud add <profile>`",
    );
  }
  const profile = settings.profiles[name];
  if (!profile) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new CloudProfileError(
      `Cloud profile ${JSON.stringify(name)} (${selection.source}) is not in ${"~/.ratel/cloud.json"}; known profiles: ${known}`,
    );
  }
  return {
    apiKey: profile.apiKey,
    tracesEndpoint: settings.tracesEndpoint,
    profile: name,
    source: selection.source,
  };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Ratel Cloud settings at ${path} are not valid JSON`);
  }
}

function parseSettings(value: unknown): CloudSettings {
  if (!isRecord(value) || !isRecord(value.profiles)) {
    throw new Error("Ratel Cloud settings are malformed");
  }
  const profiles: Record<string, CloudProfile> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!isRecord(profile) || typeof profile.apiKey !== "string") {
      throw new Error(`Ratel Cloud profile ${JSON.stringify(name)} is malformed`);
    }
    profiles[name] = { apiKey: profile.apiKey };
  }
  return {
    tracesEndpoint:
      typeof value.tracesEndpoint === "string" && value.tracesEndpoint !== ""
        ? value.tracesEndpoint
        : DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT,
    ...(typeof value.default === "string" && value.default !== ""
      ? { default: value.default }
      : {}),
    profiles,
  };
}

/** `{endpoint, apiKey}` becomes the shared endpoint plus one default profile. */
function migrateLegacy(value: unknown): CloudSettings {
  if (!isRecord(value) || typeof value.endpoint !== "string" || typeof value.apiKey !== "string") {
    throw new Error("Ratel Cloud trace settings are malformed");
  }
  return {
    tracesEndpoint: value.endpoint,
    default: MIGRATED_PROFILE_NAME,
    profiles: { [MIGRATED_PROFILE_NAME]: { apiKey: value.apiKey } },
  };
}

function validated(settings: CloudSettings): CloudSettings {
  const profiles: Record<string, CloudProfile> = {};
  for (const [name, profile] of Object.entries(settings.profiles)) {
    // Reuse the relay's endpoint and header-safety rules so an unusable pair
    // cannot reach the store in the first place.
    const checked = cloudOtlpTraceRelayOptions({
      endpoint: settings.tracesEndpoint,
      apiKey: profile.apiKey,
    });
    profiles[name] = { apiKey: checked.apiKey };
  }
  if (settings.default !== undefined && !profiles[settings.default]) {
    throw new Error(
      `Ratel Cloud default profile ${JSON.stringify(settings.default)} is not defined`,
    );
  }
  return {
    tracesEndpoint: cloudOtlpTraceRelayOptions({
      endpoint: settings.tracesEndpoint,
      apiKey: "rtl_placeholder",
    }).endpoint.toString(),
    ...(settings.default !== undefined ? { default: settings.default } : {}),
    profiles,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
