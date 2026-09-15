import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPlainObject } from "@ratel-ai/ratel-local-core";
import {
  CLOUD_API_KEY_ENV,
  CLOUD_OTLP_TRACES_ENDPOINT_ENV,
  type CloudOtlpTraceRelayOptions,
  cloudOtlpTraceRelayOptions,
} from "./otlp-trace-relay.js";
import { DEFAULT_CLOUD_BASE_URL } from "./settings.js";
import { secretFreeHttpsUrl } from "./url.js";

/** Paths are the protocol, not a setting: only the deployment they sit on varies. */
export const CLOUD_TRACES_PATH = "/api/v1/traces";
export const CLOUD_LOGS_PATH = "/api/v1/logs";
export const DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT = `${DEFAULT_CLOUD_BASE_URL}${CLOUD_TRACES_PATH}`;

/**
 * The relay's own store, one endpoint and one key. Cloud profiles live in
 * `cloud.json` and serve the catalog; an agent's exporter is configured once per
 * machine, so telemetry stays on one account and the two never share a type.
 */
export interface CloudTraceSettings {
  endpoint: string;
  apiKey: string;
}

export interface CloudTraceSettingsStoreLike {
  load(): Promise<CloudTraceSettings | undefined>;
  save(settings: CloudTraceSettings): Promise<void>;
}

export function cloudTraceSettingsPath(homeDir: string): string {
  return join(homeDir, ".ratel", "cloud-traces.json");
}

/** Logs ride the deployment the traces endpoint names; only that endpoint is stored. */
export function cloudTraceRelayOptions(settings: CloudTraceSettings): CloudOtlpTraceRelayOptions {
  const traces = secretFreeHttpsUrl(settings.endpoint, "Cloud OTLP trace endpoint");
  return cloudOtlpTraceRelayOptions({
    endpoint: traces.toString(),
    logsEndpoint: new URL(CLOUD_LOGS_PATH, traces),
    apiKey: settings.apiKey,
  });
}

export function cloudOtlpRelayOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): CloudOtlpTraceRelayOptions | undefined {
  const endpoint = env[CLOUD_OTLP_TRACES_ENDPOINT_ENV];
  const apiKey = env[CLOUD_API_KEY_ENV];
  if (!endpoint && !apiKey) return undefined;
  if (!endpoint) {
    throw new Error(
      `Cloud OTLP trace relay requires endpoint environment variable ${CLOUD_OTLP_TRACES_ENDPOINT_ENV}`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `Cloud OTLP trace relay requires daemon credential environment variable ${CLOUD_API_KEY_ENV}`,
    );
  }
  return cloudTraceRelayOptions({ endpoint, apiKey });
}

export class CloudTraceSettingsStore implements CloudTraceSettingsStoreLike {
  constructor(private readonly path: string) {}

  async load(): Promise<CloudTraceSettings | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Ratel Cloud trace settings are not valid JSON");
    }
    if (
      !isPlainObject(value) ||
      typeof value.endpoint !== "string" ||
      typeof value.apiKey !== "string"
    ) {
      throw new Error("Ratel Cloud trace settings are malformed");
    }
    return validatedSettings({ endpoint: value.endpoint, apiKey: value.apiKey });
  }

  async save(settings: CloudTraceSettings): Promise<void> {
    const validated = validatedSettings(settings);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
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

function validatedSettings(settings: CloudTraceSettings): CloudTraceSettings {
  const validated = cloudTraceRelayOptions(settings);
  return { endpoint: validated.endpoint.toString(), apiKey: validated.apiKey };
}
