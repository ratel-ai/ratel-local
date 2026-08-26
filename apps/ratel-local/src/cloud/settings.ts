import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { headerSafeSecret } from "./header-safe-secret.js";
import { secretFreeHttpsUrl } from "./url.js";

export const DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT = "https://cloud.ratel.sh/api/v1/traces";

export const CLOUD_PROFILE_ENV = "RATEL_PROFILE";

export interface CloudProfile {
  apiKey: string;
}

export interface CloudSettings {
  tracesEndpoint: string;
  default?: string;
  profiles: Record<string, CloudProfile>;
}

export interface CloudSettingsStoreLike {
  load(): Promise<CloudSettings | undefined>;
  save(settings: CloudSettings): Promise<void>;
}

export interface ResolvedCloudCredential {
  apiKey: string;
  tracesEndpoint: string;
}

/** Unknown name is an error, never a silent fall back to `default` (ADR-0021). */
export function resolveCloudCredential(
  settings: CloudSettings,
  selection: { profile?: string; source: string },
): ResolvedCloudCredential | undefined {
  const name = selection.profile ?? settings.default;
  if (!name) return undefined;
  const profile = settings.profiles[name];
  if (!profile) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new Error(
      `Cloud profile ${JSON.stringify(name)} (${selection.source}) is not in cloud.json; known profiles: ${known}`,
    );
  }
  return { apiKey: profile.apiKey, tracesEndpoint: settings.tracesEndpoint };
}

export function cloudSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud.json");
}

export function legacyCloudSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud-traces.json");
}

export const MIGRATED_PROFILE_NAME = "default";

export class CloudSettingsStore implements CloudSettingsStoreLike {
  constructor(
    private readonly path: string,
    private readonly legacyPath: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async load(): Promise<CloudSettings | undefined> {
    const current = await readJsonFile(this.path);
    if (current !== undefined) return validated(parseSettings(current));
    const legacy = await readJsonFile(this.legacyPath);
    if (legacy === undefined) return undefined;
    this.log(
      `[ratel] read Cloud settings from ${this.legacyPath}; they move to ${this.path} on the next save, after which the old file is unused and still holds a key`,
    );
    return validated(migrateLegacy(legacy));
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

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) return undefined;
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
  if (settings.default !== undefined && !settings.profiles[settings.default]) {
    throw new Error(
      `Ratel Cloud default profile ${JSON.stringify(settings.default)} is not defined`,
    );
  }
  for (const [name, { apiKey }] of Object.entries(settings.profiles)) {
    headerSafeSecret(apiKey, `Cloud profile ${name} API key`);
  }
  return {
    ...settings,
    tracesEndpoint: secretFreeHttpsUrl(
      settings.tracesEndpoint,
      "Ratel Cloud traces endpoint",
    ).toString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
