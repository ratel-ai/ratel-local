import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type JsonFs,
  parseConfig,
  type RatelScope,
  ratelConfigPath,
  readJson,
} from "@ratel-ai/ratel-local-core";
import {
  type CloudSettings,
  CloudSettingsStore,
  cloudEndpoints,
  cloudSettingsPath,
  legacyCloudSettingsPath,
} from "./settings.js";

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

export interface CloudDiagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  action: string;
}

export interface CloudEnv {
  homeDir: string;
  projectRoot?: string;
}

export interface CloudScopeScan {
  /** The nearest scope naming a profile. Nearest wins: local, then project, then user. */
  selected?: { profile: string; path: string };
  unreadable: Array<{ path: string; message: string }>;
}

/**
 * Read per scope rather than merged: `mergeConfigs` keeps the name and loses the
 * file, and a wrong binding has to name the file that made it (ADR-0021).
 */
export async function scanCloudProfileScopes(input: {
  env: CloudEnv;
  fs: JsonFs;
}): Promise<CloudScopeScan> {
  const found: Array<{ profile: string; path: string }> = [];
  const unreadable: Array<{ path: string; message: string }> = [];
  for (const scope of SCOPES) {
    const path = scopedConfigPath(scope, input.env);
    if (!path) continue;
    try {
      const document = await readJson<unknown>(input.fs, path);
      const profile = document === null ? undefined : parseConfig(document).cloud?.profile;
      if (profile) found.push({ profile, path });
    } catch (error) {
      unreadable.push({ path, message: (error as Error).message });
    }
  }
  const selected = found.at(-1);
  return { ...(selected ? { selected } : {}), unreadable };
}

function scopedConfigPath(scope: RatelScope, env: CloudEnv): string | undefined {
  try {
    return ratelConfigPath(scope, env);
  } catch {
    return undefined;
  }
}

/** Everything about the Cloud credential that can be checked without the network. */
export async function inventoryCloudSettings(input: {
  env: CloudEnv;
  fs: JsonFs;
}): Promise<CloudDiagnostic[]> {
  const diagnostics: CloudDiagnostic[] = [];
  const path = cloudSettingsPath(input.env.homeDir);
  const legacyPath = legacyCloudSettingsPath(input.env.homeDir);
  const store = new CloudSettingsStore(path, legacyPath);

  const settings = await store.load().catch((error: Error) => {
    diagnostics.push({
      code: "cloud_settings_unreadable",
      severity: "error",
      message: `${path} could not be read: ${error.message}`,
      action: `repair or remove ${path}; the daemon starts with no Cloud credential until it parses`,
    });
    return undefined;
  });

  diagnostics.push(...(await exposedSecrets(path)));

  if ((await legacyApiKey(legacyPath)) && (await exists(path))) {
    diagnostics.push({
      code: "cloud_settings_legacy_present",
      severity: "warning",
      message: `${legacyPath} is no longer read and still holds an API key`,
      action: `delete ${legacyPath} once you no longer need to downgrade`,
    });
  }

  diagnostics.push(...splitDeployment(settings));

  const scopes = await scanCloudProfileScopes(input);
  for (const scope of scopes.unreadable) {
    diagnostics.push({
      code: "cloud_config_unreadable",
      severity: "warning",
      message: `${scope.path} could not be read, so the profile it selects is unknown: ${scope.message}`,
      action: `repair ${scope.path}`,
    });
  }

  const selected = scopes.selected;
  if (selected && settings && !settings.profiles[selected.profile]) {
    const known = Object.keys(settings.profiles).sort().join(", ") || "none";
    diagnostics.push({
      code: "cloud_profile_unresolved",
      severity: "error",
      message: `${selected.path} selects Cloud profile "${selected.profile}", which ${path} does not define; stored profiles: ${known}`,
      action: `run "ratel-local cloud add ${selected.profile}", or select a stored profile with "ratel-local cloud use"`,
    });
  }
  if (selected && !settings) {
    diagnostics.push({
      code: "cloud_profile_unresolved",
      severity: "error",
      message: `${selected.path} selects Cloud profile "${selected.profile}", but no Cloud credential is stored`,
      action: `run "ratel-local cloud add ${selected.profile}"`,
    });
  }
  return diagnostics;
}

/**
 * Overriding one signal is a deliberate escape hatch; forgetting one while moving
 * deployment is not, and the two look identical from the outside.
 */
function splitDeployment(settings: CloudSettings | undefined): CloudDiagnostic[] {
  const origins = Object.entries(cloudEndpoints(settings)).map(
    ([signal, url]) => [signal, url.origin] as const,
  );
  if (new Set(origins.map(([, origin]) => origin)).size < 2) return [];
  return [
    {
      code: "cloud_endpoints_split",
      severity: "warning",
      message: `Cloud signals are split across deployments: ${origins
        .map(([signal, origin]) => `${signal} on ${origin}`)
        .join(", ")}`,
      action: "set `baseUrl` and drop the per-signal endpoints, unless the split is deliberate",
    },
  ];
}

/** A stored key that other users can read is a leaked key. */
async function exposedSecrets(path: string): Promise<CloudDiagnostic[]> {
  const diagnostics: CloudDiagnostic[] = [];
  for (const [target, expected] of [
    [path, 0o600],
    [dirname(path), 0o700],
  ] as const) {
    const mode = await modeOf(target);
    if (mode === undefined || (mode & 0o077) === 0) continue;
    diagnostics.push({
      code: "cloud_settings_permissions",
      severity: "error",
      message: `${target} is ${mode.toString(8).padStart(3, "0")}, so other users on this machine can read the stored API key`,
      action: `run "chmod ${expected.toString(8)} ${target}"`,
    });
  }
  return diagnostics;
}

async function modeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await modeOf(path)) !== undefined;
}

/** The warning claims a key is still there, so look rather than assume. */
async function legacyApiKey(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { apiKey?: unknown }).apiKey === "string" &&
      (parsed as { apiKey: string }).apiKey !== ""
    );
  } catch {
    return false;
  }
}
