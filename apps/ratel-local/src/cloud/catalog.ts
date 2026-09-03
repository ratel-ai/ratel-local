import type { CloudCatalogPullResult } from "@ratel-ai/ratel-local-core";
import type { Skill } from "@ratel-ai/sdk";
import { headerSafeSecret } from "./header-safe-secret.js";
import { secretFreeHttpsUrl } from "./url.js";

export const DEFAULT_CLOUD_CATALOG_ENDPOINT = "https://cloud.ratel.sh/api/v1/catalog";

const TIMEOUT_MS = 10_000;
const AUTH_FAILURE_COOLDOWN_MS = 60_000;
const UNAVAILABLE_COOLDOWN_MS = TIMEOUT_MS;

/** The wire projection `protocol/v1` serves: exactly these seven fields. */
const WIRE_FIELDS = ["id", "name", "description", "tags", "tools", "metadata", "body"] as const;

/**
 * One pull of the published Cloud catalog. `catalogVersion` is the source's
 * ETag, echoed back as `If-None-Match` on the next pull, and is the value a
 * gateway generation keys on.
 */
export interface CloudCatalogSnapshot {
  catalogVersion: string;
  skills: Skill[];
}

export interface CloudCatalogLoadResult {
  snapshot: CloudCatalogSnapshot;
  /** Set when the snapshot is a cached one served through an upstream failure. */
  degraded?: string;
}

export interface CloudCatalogLoaderOptions {
  endpoint: string;
  apiKey: string;
  /** Injected by tests; the daemon uses the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected by tests; the daemon uses the wall clock. */
  now?: () => number;
}

export class CloudCatalogAuthError extends Error {
  constructor(status: number) {
    super(`Cloud catalog auth failed: HTTP ${status}`);
    this.name = "CloudCatalogAuthError";
  }
}

export class CloudCatalogProtocolError extends Error {
  constructor(reason: string) {
    super(`Ratel Cloud returned a malformed catalog: ${reason}`);
    this.name = "CloudCatalogProtocolError";
  }
}

export class CloudCatalogUnavailableError extends Error {
  constructor(reason: string) {
    super(`Ratel Cloud catalog is unavailable and nothing is cached: ${reason}`);
    this.name = "CloudCatalogUnavailableError";
  }
}

export function cloudCatalogEndpoint(value: string): URL {
  return secretFreeHttpsUrl(value, "Ratel Cloud catalog endpoint");
}

/**
 * Conditional-GET client for the `protocol/v1` catalog pull.
 * The cache lives for this loader's lifetime — a restart re-pulls. A cached
 * snapshot covers availability failures only; a revoked key or contract
 * violation always surfaces. Auth failures and uncached misses are held
 * briefly so context resolves do not retry Cloud in a loop.
 */
export function createCloudCatalogLoader(options: CloudCatalogLoaderOptions) {
  const endpoint = cloudCatalogEndpoint(options.endpoint);
  headerSafeSecret(options.apiKey, "Ratel Cloud API key");
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CloudCatalogSnapshot | undefined;
  let rejected: { until: number; status: number } | undefined;
  let unavailable: { until: number; reason: string } | undefined;

  return {
    async load() {
      if (rejected && now() < rejected.until) throw new CloudCatalogAuthError(rejected.status);
      if (!cached && unavailable && now() < unavailable.until) {
        throw new CloudCatalogUnavailableError(unavailable.reason);
      }
      const degrade = (reason: string) => {
        if (!cached) unavailable = { until: now() + UNAVAILABLE_COOLDOWN_MS, reason };
        return degradeOrThrow(cached, reason);
      };
      let response: Response;
      try {
        response = await fetchUpstream(endpoint, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            Accept: "application/json",
            ...(cached ? { "If-None-Match": `"${cached.catalogVersion}"` } : {}),
          },
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        return degrade((error as Error).message);
      }

      if (response.status === 401 || response.status === 403) {
        rejected = { until: now() + AUTH_FAILURE_COOLDOWN_MS, status: response.status };
        throw new CloudCatalogAuthError(response.status);
      }
      if (response.status === 304) {
        if (!cached) {
          throw new CloudCatalogProtocolError("304 without a cached catalog");
        }
        return { snapshot: handout(cached) };
      }
      if (response.status !== 200) {
        return degrade(`HTTP ${response.status}`);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return degrade((error as Error).message);
      }
      cached = parseCatalog(text);
      return { snapshot: handout(cached) };
    },
  };
}

/**
 * Catalog pull injected into the context resolver. Reads the credential on
 * each call so a rotated key applies without a restart, and reuses one loader
 * so the conditional-GET cache survives across pulls.
 */
export function createCloudCatalogSource(input: {
  apiKey: () => Promise<string | undefined>;
  endpoint?: string;
  log: (message: string) => void;
  fetch?: typeof fetch;
}) {
  let current: { apiKey: string; loader: ReturnType<typeof createCloudCatalogLoader> } | undefined;
  const endpoint = input.endpoint ?? DEFAULT_CLOUD_CATALOG_ENDPOINT;

  return async (): Promise<CloudCatalogPullResult | undefined> => {
    const apiKey = await input.apiKey();
    if (!apiKey) return undefined;
    if (current?.apiKey !== apiKey) {
      current = {
        apiKey,
        loader: createCloudCatalogLoader({
          endpoint,
          apiKey,
          fetch: input.fetch,
        }),
      };
    }
    const { snapshot, degraded } = await current.loader.load();
    if (degraded) input.log(`[ratel] serving a cached Cloud catalog: ${degraded}`);
    return { catalog: snapshot, ...(degraded ? { degraded } : {}) };
  };
}

function handout(snapshot: CloudCatalogSnapshot): CloudCatalogSnapshot {
  // Copy the array; skill objects stay shared.
  return { catalogVersion: snapshot.catalogVersion, skills: [...snapshot.skills] };
}

function degradeOrThrow(
  cached: CloudCatalogSnapshot | undefined,
  reason: string,
): CloudCatalogLoadResult {
  if (!cached) throw new CloudCatalogUnavailableError(reason);
  return { snapshot: handout(cached), degraded: reason };
}

function parseCatalog(text: string): CloudCatalogSnapshot {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CloudCatalogProtocolError("response is not JSON");
  }
  if (!isRecord(body)) throw new CloudCatalogProtocolError("response is not an object");
  const { catalogVersion, skills } = body;
  if (typeof catalogVersion !== "string" || catalogVersion === "") {
    throw new CloudCatalogProtocolError("catalogVersion is missing");
  }
  if (/[\r\n]/.test(catalogVersion)) {
    throw new CloudCatalogProtocolError("catalogVersion is not header-safe");
  }
  if (!Array.isArray(skills)) throw new CloudCatalogProtocolError("skills is not an array");
  return { catalogVersion, skills: skills.map(toSkill) };
}

/**
 * The wire projection is frozen and stricter than the SDK `Skill` type: all
 * seven fields are required on the wire, while the SDK marks `tags`, `tools`,
 * `metadata`, and `body` optional. A missing field is a genuine contract
 * violation. Unknown fields are dropped: the schema allows a source to carry
 * extras, and a conforming client ignores them.
 */
function toSkill(value: unknown, index: number): Skill {
  if (!isRecord(value)) throw new CloudCatalogProtocolError(`skill ${index} is not an object`);
  for (const field of WIRE_FIELDS) {
    if (!(field in value)) {
      throw new CloudCatalogProtocolError(`skill ${index} is missing ${field}`);
    }
  }
  const { id, name, description, tags, tools, metadata, body } = value;
  if (typeof id !== "string" || id === "") {
    throw new CloudCatalogProtocolError(`skill ${index} has an invalid id`);
  }
  if (typeof name !== "string" || typeof description !== "string" || typeof body !== "string") {
    throw new CloudCatalogProtocolError(`skill ${id} has an invalid name, description, or body`);
  }
  if (!isStringArray(tags) || !isStringArray(tools)) {
    throw new CloudCatalogProtocolError(`skill ${id} has invalid tags or tools`);
  }
  if (!isRecord(metadata) || !Object.values(metadata).every(isStringArray)) {
    throw new CloudCatalogProtocolError(`skill ${id} has invalid metadata`);
  }
  return {
    id,
    name,
    description,
    tags,
    tools,
    metadata: metadata as Record<string, string[]>,
    body,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
