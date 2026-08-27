import type { CloudSkillCatalog } from "@ratel-ai/ratel-local-core";
import type { Skill } from "@ratel-ai/sdk";
import { headerSafeSecret } from "./header-safe-secret.js";
import { secretFreeHttpsUrl } from "./url.js";

const TIMEOUT_MS = 10_000;

/** What one pull returned, and whether it came from the cache. */
export interface CloudCatalogLoadResult {
  snapshot: CloudSkillCatalog;
  /** Set when the snapshot is a cached one served through an upstream failure. */
  degraded?: string;
}

export interface CloudCatalogLoaderOptions {
  endpoint: string;
  apiKey: string;
  /** Injected by tests; the daemon uses the global `fetch`. */
  fetch?: typeof fetch;
}

const protocolError = (reason: string) =>
  new Error(`Ratel Cloud returned a malformed catalog: ${reason}`);
const unavailableError = (reason: string) =>
  new Error(`Ratel Cloud catalog is unavailable and nothing is cached: ${reason}`);

/**
 * Conditional-GET client for the `protocol/v1` catalog pull.
 *
 * The cache lives for the life of this loader — a daemon restart re-pulls.
 * Deliberately: the contract serves `Cache-Control: no-cache`, so every
 * acquisition revalidates anyway, and a disk cache would add an offline story
 * the vertical slice does not need.
 * Concurrent `load()` calls each pull: the cache is assigned after the await,
 * so nothing dedupes them. Share one in-flight promise if that ever costs.
 *
 * A cached snapshot covers *availability* failures only. An invalid credential
 * or a contract violation always surfaces, so a revoked key cannot hide behind
 * the last good catalog indefinitely.
 */
export function createCloudCatalogLoader(options: CloudCatalogLoaderOptions) {
  const endpoint = secretFreeHttpsUrl(options.endpoint, "Ratel Cloud catalog endpoint");
  headerSafeSecret(options.apiKey, "Ratel Cloud API key");
  const fetchUpstream = options.fetch ?? fetch;
  let cached: CloudSkillCatalog | undefined;

  return {
    async load() {
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
        return degradeOrThrow(cached, (error as Error).message);
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Cloud catalog auth failed: HTTP ${response.status}`);
      }
      if (response.status === 304) {
        if (!cached) {
          throw protocolError("304 without a cached catalog");
        }
        return { snapshot: handout(cached) };
      }
      if (response.status !== 200) {
        return degradeOrThrow(cached, `HTTP ${response.status}`);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        return degradeOrThrow(cached, (error as Error).message);
      }
      cached = parseCatalog(text);
      return { snapshot: handout(cached) };
    },
  };
}

function handout(snapshot: CloudSkillCatalog): CloudSkillCatalog {
  // The cache is only replaced on a 200: while the ETag matches, a consumer that
  // mutated this array would keep an empty catalog for the process lifetime.
  return { catalogVersion: snapshot.catalogVersion, skills: [...snapshot.skills] };
}

function degradeOrThrow(
  cached: CloudSkillCatalog | undefined,
  reason: string,
): CloudCatalogLoadResult {
  if (!cached) throw unavailableError(reason);
  return { snapshot: handout(cached), degraded: reason };
}

function parseCatalog(text: string): CloudSkillCatalog {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw protocolError("response is not JSON");
  }
  if (!isRecord(body)) throw protocolError("response is not an object");
  const { catalogVersion, skills } = body;
  if (typeof catalogVersion !== "string" || catalogVersion === "") {
    throw protocolError("catalogVersion is missing");
  }
  if (/[\r\n]/.test(catalogVersion)) {
    throw protocolError("catalogVersion is not header-safe");
  }
  if (!Array.isArray(skills)) throw protocolError("skills is not an array");
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
  if (!isRecord(value)) throw protocolError(`skill ${index} is not an object`);
  const { id, name, description, tags, tools, metadata, body } = value;
  if (typeof id !== "string" || id === "") {
    throw protocolError(`skill ${index} has an invalid id`);
  }
  if (typeof name !== "string" || typeof description !== "string" || typeof body !== "string") {
    throw protocolError(`skill ${id} has an invalid name, description, or body`);
  }
  if (!isStringArray(tags) || !isStringArray(tools)) {
    throw protocolError(`skill ${id} has invalid tags or tools`);
  }
  if (!isRecord(metadata) || !Object.values(metadata).every(isStringArray)) {
    throw protocolError(`skill ${id} has invalid metadata`);
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
