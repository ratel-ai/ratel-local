import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { headerSafeSecret } from "./header-safe-secret.js";
import { secretFreeHttpsUrl } from "./url.js";

/** The deployment every install talks to unless `baseUrl` says otherwise. */
export const DEFAULT_CLOUD_BASE_URL = "https://cloud.ratel.sh";
/** Paths are the protocol, not a setting: only the deployment they sit on varies. */
export const CLOUD_TRACES_PATH = "/api/v1/traces";
export const CLOUD_LOGS_PATH = "/api/v1/logs";
export const CLOUD_CATALOG_PATH = "/api/v1/catalog";
export const DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT = `${DEFAULT_CLOUD_BASE_URL}${CLOUD_TRACES_PATH}`;

export const CLOUD_PROFILE_ENV = "RATEL_PROFILE";

export interface CloudProfile {
  apiKey: string;
}

export interface CloudSettings {
  /** The deployment. Origin only; a path prefix needs the three explicit endpoints. */
  baseUrl?: string;
  /** Full per-signal overrides, for a prefix or one signal aimed elsewhere. */
  tracesEndpoint?: string;
  logsEndpoint?: string;
  catalogEndpoint?: string;
  default?: string;
  profiles: Record<string, CloudProfile>;
}

export function cloudSettingsForTracesEndpoint(
  endpoint: string,
): Pick<CloudSettings, "baseUrl" | "tracesEndpoint"> {
  const url = new URL(endpoint);
  return {
    baseUrl: url.origin,
    ...(url.pathname === CLOUD_TRACES_PATH ? {} : { tracesEndpoint: url.toString() }),
  };
}

export interface CloudEndpoints {
  traces: URL;
  logs: URL;
  catalog: URL;
}

/** Each signal: its own override, else the deployment's path. One rule, no derivation. */
export function cloudEndpoints(settings?: CloudSettings): CloudEndpoints {
  const base = settings?.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
  const on = (path: string) => new URL(path, base);
  return {
    traces: settings?.tracesEndpoint ? new URL(settings.tracesEndpoint) : on(CLOUD_TRACES_PATH),
    logs: settings?.logsEndpoint ? new URL(settings.logsEndpoint) : on(CLOUD_LOGS_PATH),
    catalog: settings?.catalogEndpoint ? new URL(settings.catalogEndpoint) : on(CLOUD_CATALOG_PATH),
  };
}

export interface CloudSettingsStoreLike {
  load(): Promise<CloudSettings | undefined>;
  save(settings: CloudSettings): Promise<void>;
}

export interface ResolvedCloudCredential {
  apiKey: string;
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
  return { apiKey: profile.apiKey };
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
      `read Cloud settings from ${this.legacyPath}; they move to ${this.path} on the next save, after which the old file is unused and still holds a key`,
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
  const url = (key: "baseUrl" | "tracesEndpoint" | "logsEndpoint" | "catalogEndpoint") =>
    typeof value[key] === "string" && value[key] !== "" ? { [key]: value[key] } : {};
  return {
    ...url("baseUrl"),
    ...url("tracesEndpoint"),
    ...url("logsEndpoint"),
    ...url("catalogEndpoint"),
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
    ...cloudSettingsForTracesEndpoint(value.endpoint),
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
  const checked = { ...settings };
  for (const key of ["tracesEndpoint", "logsEndpoint", "catalogEndpoint"] as const) {
    const value = checked[key];
    if (value !== undefined)
      checked[key] = secretFreeHttpsUrl(value, `Ratel Cloud ${key}`).toString();
  }
  // Stored as an origin because that is all of it the paths are joined to: a
  // prefix written here would be dropped at use, so it is dropped on the way in.
  if (checked.baseUrl !== undefined) {
    checked.baseUrl = secretFreeHttpsUrl(checked.baseUrl, "Ratel Cloud baseUrl").origin;
  }
  return checked;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
