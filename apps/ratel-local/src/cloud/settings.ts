import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cloudOtlpTraceRelayOptions } from "./otlp-trace-relay.js";

export const DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT = "https://cloud.ratel.sh/api/v1/traces";

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
      !isRecord(value) ||
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
  const validated = cloudOtlpTraceRelayOptions({
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
  });
  return { endpoint: validated.endpoint.toString(), apiKey: validated.apiKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
