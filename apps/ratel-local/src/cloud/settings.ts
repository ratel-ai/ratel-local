import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPlainObject } from "@ratel-ai/ratel-local-core";
import lockfile from "proper-lockfile";
import { headerSafeSecret } from "./header-safe-secret.js";
import { secretFreeHttpsUrl } from "./url.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const LOCK_OPTS = {
  realpath: false,
  retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 200 },
  stale: 10_000,
} as const;

/** The deployment every install talks to unless `baseUrl` says otherwise. */
export const DEFAULT_CLOUD_BASE_URL = "https://cloud.ratel.sh";
/** Paths are the protocol, not a setting: only the deployment they sit on varies. */
export const CLOUD_CATALOG_PATH = "/api/v1/catalog";

export interface CloudProfile {
  apiKey: string;
}

export interface CloudSettings {
  /** The deployment. Origin only; a path prefix needs the three explicit endpoints. */
  baseUrl?: string;
  /** Full override, for a prefix or a catalog aimed elsewhere. */
  catalogEndpoint?: string;
  default?: string;
  profiles: Record<string, CloudProfile>;
}

export interface CloudEndpoints {
  catalog: URL;
}

/** The override, else the deployment's path. One rule, no derivation. */
export function cloudEndpoints(settings?: CloudSettings): CloudEndpoints {
  const base = settings?.baseUrl ?? DEFAULT_CLOUD_BASE_URL;
  return {
    catalog: settings?.catalogEndpoint
      ? new URL(settings.catalogEndpoint)
      : new URL(CLOUD_CATALOG_PATH, base),
  };
}

export interface CloudSettingsStoreLike {
  load(): Promise<CloudSettings | undefined>;
  save(settings: CloudSettings): Promise<void>;
  /** Locked RMW; do not prompt or scan other files inside the mutator. */
  update(
    mutator: (current: CloudSettings) => CloudSettings | Promise<CloudSettings>,
  ): Promise<CloudSettings>;
}

/** Unknown name is an error, never a silent fall back to `default` (ADR-0021). */
export function resolveCloudCredential(
  settings: CloudSettings,
  selection: { profile?: string; source: string },
): string | undefined {
  const name = selection.profile ?? settings.default;
  if (!name) return undefined;
  const profile = settings.profiles[name];
  if (!profile) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    throw new Error(
      `Cloud profile ${JSON.stringify(name)} (${selection.source}) is not in cloud.json; known profiles: ${known}`,
    );
  }
  return profile.apiKey;
}

export function cloudSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud.json");
}

export class CloudSettingsStore implements CloudSettingsStoreLike {
  constructor(private readonly path: string) {}

  async load(): Promise<CloudSettings | undefined> {
    const current = await readJsonFile(this.path);
    return current === undefined ? undefined : validated(parseSettings(current));
  }

  async save(settings: CloudSettings): Promise<void> {
    await this.withLock(() => this.writeUnlocked(settings));
  }

  async update(
    mutator: (current: CloudSettings) => CloudSettings | Promise<CloudSettings>,
  ): Promise<CloudSettings> {
    return this.withLock(async () => {
      const current = (await this.load()) ?? { profiles: {} };
      const next = await mutator(current);
      await this.writeUnlocked(next);
      return next;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: DIR_MODE });
    await chmod(dirname(this.path), DIR_MODE).catch(() => undefined);
    const release = await lockfile.lock(this.path, LOCK_OPTS);
    try {
      return await fn();
    } finally {
      await release().catch(() => undefined);
    }
  }

  private async writeUnlocked(settings: CloudSettings): Promise<void> {
    const next = validated(settings);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: DIR_MODE });
    await chmod(directory, DIR_MODE);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, FILE_MODE);
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
  if (!isPlainObject(value) || !isPlainObject(value.profiles)) {
    throw new Error("Ratel Cloud settings are malformed");
  }
  const profiles: Record<string, CloudProfile> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!isPlainObject(profile) || typeof profile.apiKey !== "string") {
      throw new Error(`Ratel Cloud profile ${JSON.stringify(name)} is malformed`);
    }
    profiles[name] = { apiKey: profile.apiKey };
  }
  const url = (key: "baseUrl" | "catalogEndpoint") =>
    typeof value[key] === "string" && value[key] !== "" ? { [key]: value[key] } : {};
  return {
    ...url("baseUrl"),
    ...url("catalogEndpoint"),
    ...(typeof value.default === "string" && value.default !== ""
      ? { default: value.default }
      : {}),
    profiles,
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
  for (const key of ["catalogEndpoint"] as const) {
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
