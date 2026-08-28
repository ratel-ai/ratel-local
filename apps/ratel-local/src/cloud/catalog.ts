import type { CloudSkillCatalog, RuntimeContextRef } from "@ratel-ai/ratel-local-core";
import type { Skill } from "@ratel-ai/sdk";
import { headerSafeSecret } from "./header-safe-secret.js";
import {
  CLOUD_PROFILE_ENV,
  type CloudSettings,
  cloudEndpoints,
  resolveCloudCredential,
} from "./settings.js";
import { secretFreeHttpsUrl } from "./url.js";

const TIMEOUT_MS = 10_000;
/** How long a rejected key is taken at its word. A rotation builds a new loader. */
const AUTH_FAILURE_COOLDOWN_MS = 60_000;

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
  /** Injected by tests; the daemon uses the wall clock. */
  now?: () => number;
}

const protocolError = (reason: string) =>
  new Error(`Ratel Cloud returned a malformed catalog: ${reason}`);
const authFailedError = (status?: number) =>
  new Error(`Cloud catalog auth failed${status === undefined ? "" : `: HTTP ${status}`}`);
const unavailableError = (reason: string) =>
  new Error(`Ratel Cloud catalog is unavailable and nothing is cached: ${reason}`);

/**
 * Conditional-GET client for the `protocol/v1` catalog pull.
 *
 * The cache lives for the life of this loader — a daemon restart re-pulls.
 * Deliberately: the contract serves `Cache-Control: no-cache`, so every
 * acquisition revalidates anyway, and a disk cache would add an offline story
 * the vertical slice does not need.
 *
 * A cached snapshot covers *availability* failures only. An invalid credential
 * or a contract violation always surfaces, so a revoked key cannot hide behind
 * the last good catalog indefinitely.
 */
export function createCloudCatalogLoader(options: CloudCatalogLoaderOptions) {
  const endpoint = secretFreeHttpsUrl(options.endpoint, "Ratel Cloud catalog endpoint");
  headerSafeSecret(options.apiKey, "Ratel Cloud API key");
  const fetchUpstream = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CloudSkillCatalog | undefined;
  let rejectedUntil = 0;

  return {
    async load() {
      // A revoked key fails identically every time, and every context resolve
      // asks again. Hold the answer rather than ask Cloud on a loop.
      if (now() < rejectedUntil) throw authFailedError();
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
        rejectedUntil = now() + AUTH_FAILURE_COOLDOWN_MS;
        throw authFailedError(response.status);
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

interface CloudCredential {
  /** Not `endpoint`: a traces URL must not type-check here. */
  catalog: URL;
  apiKey: string;
}

/**
 * Resolves in ADR-0021's order. An unknown profile throws rather than falling
 * back, so one project cannot silently pull another's account.
 */
export function createCloudCatalogSource(input: {
  /** Read per pull: a UI save replaces the store while the daemon runs. */
  settings: () => CloudSettings | undefined;
  environment: CloudCredential | undefined;
  environmentProfile: string | undefined;
  log: (message: string) => void;
  fetch?: typeof fetch;
}) {
  const loaders = new Map<string, ReturnType<typeof createCloudCatalogLoader>>();
  const resolve = (scopeProfile?: string): CloudCredential | undefined => {
    if (input.environment) return input.environment;
    const settings = input.settings();
    const profile = input.environmentProfile ?? scopeProfile;
    const source = input.environmentProfile ? CLOUD_PROFILE_ENV : "cloud.profile";
    if (!settings) {
      if (!profile) return undefined;
      throw new Error(
        `Cloud profile ${JSON.stringify(profile)} (${source}) is selected, but no Cloud credential is stored. Add one with: ratel-local cloud add ${profile}`,
      );
    }
    const credential = resolveCloudCredential(settings, {
      ...(profile ? { profile } : {}),
      source: profile ? source : "store default",
    });
    if (!credential) return undefined;
    return { catalog: cloudEndpoints(settings).catalog, apiKey: credential.apiKey };
  };

  return async (
    _context: RuntimeContextRef,
    profile?: string,
  ): Promise<CloudSkillCatalog | undefined> => {
    const credential = resolve(profile);
    if (!credential) return undefined;
    const endpoint = credential.catalog.toString();
    const key = `${endpoint}\u0000${credential.apiKey}`;
    const loader =
      loaders.get(key) ??
      createCloudCatalogLoader({
        endpoint,
        apiKey: credential.apiKey,
        ...(input.fetch ? { fetch: input.fetch } : {}),
      });
    loaders.set(key, loader);
    const { snapshot, degraded } = await loader.load();
    if (degraded) input.log(`[ratel] serving a cached Cloud catalog: ${degraded}`);
    return snapshot;
  };
}

function handout(snapshot: CloudSkillCatalog): CloudSkillCatalog {
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
