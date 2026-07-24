import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  EmbedderError,
  type EmbeddingSpec,
  type McpServerHandle,
  registerMcpServer,
  type SearchMethod,
  type Skill,
  SkillCatalog,
  ToolCatalog,
  type ToolCatalogOptions,
  type TraceSinkConfig,
  type UpstreamServerInfo,
} from "@ratel-ai/sdk";
import type { ResolvedMcpEntry } from "../resolved-mcp.js";
import { recordToolTokenEstimate } from "../telemetry.js";
import type { RatelConfig, RetrievalConfig, ServerEntry } from "./config.js";
import { expandEnvPlaceholders } from "./env-placeholders.js";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  type AuthStep,
  defaultAuthStep,
  defaultOAuthStorePath,
  markDenseAuthReconnectRequired,
  runAuthFlow,
} from "./oauth/flow.js";
import { RatelOAuthProvider } from "./oauth/provider.js";
import { refreshIfNeeded } from "./oauth/refresh.js";
import {
  OAuthFingerprintMismatchError,
  type OAuthStoreState,
  RatelOAuthStore,
} from "./oauth/store.js";
import { wrapTransportWithSendMutex } from "./oauth/transport-mutex.js";
import { defaultSkillDirs, loadSkills } from "./skills/load.js";
import { estimateToolPayloadTokens } from "./usage.js";

export interface TransportRuntimeInputs {
  cwd: string;
  oauthStorePath: string;
  oauthStoreFingerprint?: string;
}

export type TransportFactory = (
  name: string,
  entry: ServerEntry,
  runtime?: TransportRuntimeInputs,
) => Transport | undefined;

/**
 * Optional injection point for token refresh during gateway boot. The default is
 * `refreshIfNeeded` against the upstream's on-disk OAuth store; tests stub it.
 * Throw `RefreshFailedError` (or any error) to signal the upstream needs re-auth.
 */
export type RefreshTokensFn = (store: RatelOAuthStore, name: string) => Promise<unknown>;

export interface BuildGatewayOptions {
  transportFactory?: TransportFactory;
  /** Effective, provenance-preserving runtime entries. Shadowed and invalid entries are ignored. */
  resolvedMcpEntries?: ResolvedMcpEntry[];
  logger?: (message: string) => void;
  /** Override the per-upstream OAuth state path. Defaults to `~/.ratel/oauth/<name>.json`. */
  oauthStorePath?: (serverName: string) => string;
  /** Override the auth-flow step (mainly for tests / DI). */
  authStep?: AuthStep;
  /** Override boot-time token refresh. Default: refreshIfNeeded against the upstream's store. */
  refreshTokens?: RefreshTokensFn;
  /** Trace sink configuration; forwarded to the catalog. Default: noop (no events captured). */
  trace?: TraceSinkConfig;
  /** Override the Ratel-managed skill directories. Default: `config.skills.dirs` then `~/.ratel/skills`. */
  skillDirs?: string[];
  /** Override skill discovery (mainly for tests / DI). Default: scan {@link skillDirs}. */
  loadSkills?: (dirs: string[], opts: { logger?: (message: string) => void }) => Promise<Skill[]>;
  /** Pre-resolved effective skills. When supplied, the gateway performs no discovery of its own. */
  resolvedSkills?: Skill[];
  /** Resolved scoped retrieval block. Overrides config.retrieval when supplied. */
  retrieval?: RetrievalConfig;
}

const PLACEHOLDER_REDIRECT_URL = "http://127.0.0.1:0/cb";

const AUTH_SHAPED_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /prepareTokenRequest/i,
  /authorizationCode is required/i,
  /invalid_grant/i,
  /\b(401|403|unauthori[sz]ed|forbidden)\b/i,
];

function isAuthShapedError(err: unknown): boolean {
  const msg = (err as { message?: unknown } | null)?.message;
  if (typeof msg !== "string") return false;
  return AUTH_SHAPED_ERROR_PATTERNS.some((re) => re.test(msg));
}

function isAuthRequiredError(err: unknown): boolean {
  if (isUnauthorized(err) || isAuthShapedError(err)) return true;

  const status = getAuthStatus(err);
  if (status === 401 || status === 403) return true;

  const code = (err as { code?: unknown } | null)?.code;
  return code === 401 || code === 403 || code === "Unauthorized" || code === "ERR_UNAUTHORIZED";
}

function getAuthStatus(err: unknown): unknown {
  const shaped = err as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  } | null;
  return shaped?.status ?? shaped?.statusCode ?? shaped?.response?.status;
}

export interface GatewayHandle {
  catalog: ToolCatalog;
  /** Ratel-managed skills, ranked by the same engine and dispatched on demand. */
  skillCatalog: SkillCatalog;
  upstreamServers: UpstreamServerInfo[];
  close: () => Promise<void>;
  /** Drives an interactive OAuth flow for one or all upstreams marked `needsAuth`. */
  runAuthFlow: (opts?: AuthFlowOptions) => Promise<AuthFlowResult[]>;
  /** Wires a `notifications/tools/list_changed` emitter; called after each successful auth. */
  setListChangedNotifier: (fn: (() => void | Promise<void>) | undefined) => void;
}

export async function buildGatewayFromConfig(
  config: RatelConfig,
  options: BuildGatewayOptions = {},
): Promise<GatewayHandle> {
  const factory = options.transportFactory ?? defaultTransportFactory;
  const log = options.logger ?? ((m) => console.error(m));
  const effectiveEntries = options.resolvedMcpEntries
    ? options.resolvedMcpEntries.filter((candidate) => candidate.status === "effective")
    : Object.entries(config.mcpServers).map(([name, entry]) => ({
        name,
        entry,
        runtimeCwd: entry.cwd ?? process.cwd(),
        oauthKey: {
          path: options.oauthStorePath?.(name) ?? defaultOAuthStorePath(name),
          fingerprint: "legacy",
        },
      }));
  const entryByName = new Map(effectiveEntries.map((candidate) => [candidate.name, candidate]));
  const storePath = (serverName: string): string =>
    entryByName.get(serverName)?.oauthKey.path ??
    options.oauthStorePath?.(serverName) ??
    defaultOAuthStorePath(serverName);
  const storeFingerprint = (serverName: string): string | undefined =>
    entryByName.get(serverName)?.oauthKey.fingerprint;
  const step = options.authStep ?? defaultAuthStep({ logger: log, storePath, storeFingerprint });
  const refreshTokens = options.refreshTokens ?? defaultRefreshTokens;

  const catalogOptions = resolveCatalogOptions(
    options.retrieval ?? config.retrieval,
    options.trace,
  );
  const denseRetrieval = isDenseMethod(catalogOptions.method);
  const catalog = new ToolCatalog(catalogOptions);
  const skillCatalog = await buildSkillCatalog(config, options, catalogOptions, log);
  const handles = new Map<string, McpServerHandle>();
  const upstreamServers: UpstreamServerInfo[] = [];
  const configEntries: Record<string, ServerEntry> = Object.fromEntries(
    effectiveEntries.map(({ name, entry }) => [name, entry]),
  );
  let listChangedNotifier: (() => void | Promise<void>) | undefined;

  for (const candidate of effectiveEntries) {
    const { name, entry } = candidate;
    const runtime: TransportRuntimeInputs = {
      cwd: candidate.runtimeCwd,
      oauthStorePath: candidate.oauthKey.path,
      oauthStoreFingerprint: candidate.oauthKey.fingerprint,
    };
    if (isHttpOrSse(entry)) {
      const store = new RatelOAuthStore(storePath(name), candidate.oauthKey.fingerprint);
      let state: OAuthStoreState;
      try {
        state = await store.load();
      } catch (error) {
        if (!(error instanceof OAuthFingerprintMismatchError)) throw error;
        markNeedsAuth(upstreamServers, name, entry);
        catalog.recordEvent({ type: "auth_needs", upstream: name });
        log(
          `[ratel] ${name} OAuth target changed; re-authorization is required — run "ratel-local mcp auth ${name}"`,
        );
        continue;
      }
      if (!state.resource_fingerprint && candidate.oauthKey.fingerprint !== "legacy") {
        await store.save({ resource_fingerprint: candidate.oauthKey.fingerprint });
      }
      const hadTokens = state.tokens !== undefined;
      if (hadTokens) {
        try {
          await refreshTokens(store, name);
          catalog.recordEvent({ type: "auth_refresh", upstream: name, ok: true });
        } catch (err) {
          catalog.recordEvent({ type: "auth_refresh", upstream: name, ok: false });
          markNeedsAuth(upstreamServers, name, entry);
          catalog.recordEvent({ type: "auth_needs", upstream: name });
          log(
            `[ratel] ${name} needs re-authorization (refresh failed: ${(err as Error).message}) — run "ratel-local mcp auth ${name}"`,
          );
          continue;
        }
      }
    }

    let transport: Transport | undefined;
    try {
      transport = factory(name, entry, runtime);
      if (!transport) {
        log(`[ratel] skipping ${name}: unsupported transport type "${entry.type}"`);
        continue;
      }
      const handle = await registerMcpServer(catalog, { name, transport });
      handles.set(name, handle);
      const toolPayloads = handle.toolIds.map((id) => catalog.get(id)).filter(Boolean);
      const tokenEstimate = estimateToolPayloadTokens(toolPayloads);
      recordToolTokenEstimate(options.trace, { server: name, estimate: tokenEstimate });
      const info: UpstreamServerInfo = { name, toolCount: handle.toolIds.length };
      const description = entry.description ?? handle.serverInstructions;
      if (description) info.description = description;
      if (handle.serverInstructions) info.instructions = handle.serverInstructions;
      upstreamServers.push(info);
    } catch (err) {
      if (denseRetrieval && err instanceof EmbedderError) {
        await transport?.close().catch(() => undefined);
        await closeGatewayHandles(handles, log);
        throw err;
      }
      if (isHttpOrSse(entry) && isAuthRequiredError(err)) {
        markNeedsAuth(upstreamServers, name, entry);
        catalog.recordEvent({ type: "auth_needs", upstream: name });
        log(
          `[ratel] ${name} requires authorization — run "ratel-local mcp auth ${name}" or call the auth tool`,
        );
        continue;
      }
      log(`[ratel] failed to register ${name}: ${(err as Error).message}`);
    }
  }

  return {
    catalog,
    skillCatalog,
    upstreamServers,
    close: () => closeGatewayHandles(handles, log),
    runAuthFlow: async (opts: AuthFlowOptions = {}) => {
      if (!denseRetrieval) {
        return runAuthFlow({
          catalog,
          upstreams: upstreamServers,
          handles,
          configEntries,
          step,
          opts,
          onListChanged: () => listChangedNotifier?.(),
          logger: log,
        });
      }

      // Dense catalogs are immutable for the lifetime of one scoped gateway
      // generation. Complete OAuth against an isolated BM25 catalog so tokens
      // are persisted without hot-registering partially embedded tools into the
      // active generation. Reconnecting acquires a freshly built generation.
      const authCatalog = new ToolCatalog(options.trace ? { trace: options.trace } : {});
      const authHandles = new Map<string, McpServerHandle>();
      const authUpstreams = upstreamServers.map((upstream) => ({ ...upstream }));
      try {
        const results = await runAuthFlow({
          catalog: authCatalog,
          upstreams: authUpstreams,
          handles: authHandles,
          configEntries,
          step,
          opts,
          logger: log,
        });
        return markDenseAuthReconnectRequired(results);
      } finally {
        await closeGatewayHandles(authHandles, log);
      }
    },
    setListChangedNotifier: (fn) => {
      listChangedNotifier = fn;
    },
  };
}

/**
 * Build and populate the skill catalog from the Ratel-managed folder(s). Shares
 * the upstream trace sink so skill events land in the same telemetry stream.
 * Skill discovery failures degrade gracefully — an empty catalog, never a crash.
 */
async function buildSkillCatalog(
  config: RatelConfig,
  options: BuildGatewayOptions,
  catalogOptions: ToolCatalogOptions,
  log: (message: string) => void,
): Promise<SkillCatalog> {
  const skillCatalog = new SkillCatalog(catalogOptions);
  if (options.resolvedSkills) {
    if (options.resolvedSkills.length > 0) {
      await skillCatalog.register(options.resolvedSkills);
    }
    return skillCatalog;
  }
  const dirs = options.skillDirs ?? config.skills?.dirs ?? defaultSkillDirs();
  const load = options.loadSkills ?? loadSkills;
  let skills: Skill[];
  try {
    skills = await load(dirs, { logger: log });
  } catch (err) {
    log(`[ratel] skill loading failed: ${(err as Error).message}`);
    return skillCatalog;
  }
  if (skills.length > 0) {
    // Dense registration failures deliberately escape and abort readiness.
    await skillCatalog.register(skills);
    log(`[ratel] loaded ${skills.length} skill(s)`);
  }
  return skillCatalog;
}

function resolveCatalogOptions(
  retrieval: RetrievalConfig | undefined,
  trace: TraceSinkConfig | undefined,
): ToolCatalogOptions {
  const method = retrieval?.method ?? "bm25";
  const embedding = resolveEmbeddingSpec(retrieval?.embedding);
  return {
    ...(trace ? { trace } : {}),
    ...(method !== "bm25" ? { method } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
  };
}

function resolveEmbeddingSpec(embedding: EmbeddingSpec | undefined): EmbeddingSpec | undefined {
  if (typeof embedding === "string") return expandHomeModelPath(embedding);
  if (embedding && typeof embedding.local === "string") {
    return { ...embedding, local: expandHomeModelPath(embedding.local) } as EmbeddingSpec;
  }
  return embedding;
}

function expandHomeModelPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function isDenseMethod(method: SearchMethod | undefined): boolean {
  return method === "semantic" || method === "hybrid";
}

async function closeGatewayHandles(
  handles: Map<string, McpServerHandle>,
  log: (message: string) => void,
): Promise<void> {
  const results = await Promise.allSettled(
    Array.from(handles.values()).map((handle) => handle.close()),
  );
  handles.clear();
  for (const result of results) {
    if (result.status === "rejected") {
      log(`[ratel] error during shutdown: ${(result.reason as Error)?.message ?? result.reason}`);
    }
  }
}

export const defaultTransportFactory: TransportFactory = (name, entry, runtime) => {
  switch (entry.type) {
    case "stdio":
      if (!entry.command) return undefined;
      return new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        env: mergeDaemonAndEntryEnv(entry.env),
        cwd: runtime?.cwd ?? entry.cwd,
        stderr: "inherit",
      });
    case "http":
    case "sse":
      if (!entry.url) return undefined;
      return wrapTransportWithSendMutex(
        buildHttpTransport(
          entry,
          runtime?.oauthStorePath ?? defaultOAuthStorePath(name),
          runtime?.oauthStoreFingerprint,
        ),
      );
    default:
      return undefined;
  }
};

function buildHttpTransport(
  entry: ServerEntry,
  oauthStorePath: string,
  oauthStoreFingerprint?: string,
): Transport {
  const url = new URL(expandEnvPlaceholders(entry.url ?? ""));
  const headers = resolveHttpHeaders(entry);
  const opts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = headers
    ? { requestInit: { headers } }
    : {};
  const path = oauthStorePath;
  if (existsSync(path)) {
    const store = new RatelOAuthStore(path, oauthStoreFingerprint);
    const provider = new RatelOAuthProvider({
      store,
      // Always set redirectUrl so the SDK takes the refresh-token branch instead of
      // the prepareTokenRequest non-interactive path. See SDK auth.js line 259.
      redirectUrl: redirectUrlFromStoredFile(path) ?? PLACEHOLDER_REDIRECT_URL,
      scope: entry.scope,
      staticClientId: entry.clientId,
      staticClientSecret: entry.clientSecret,
    });
    return new StreamableHTTPClientTransport(url, { ...opts, authProvider: provider });
  }
  return new StreamableHTTPClientTransport(url, opts);
}

function mergeDaemonAndEntryEnv(
  entryEnv: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!entryEnv) return undefined;
  const daemonEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (value): value is [string, string] => value[1] !== undefined,
    ),
  );
  return { ...daemonEnv, ...entryEnv };
}

export function resolveHttpHeaders(
  entry: ServerEntry,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (entry.headers) {
    for (const [name, value] of Object.entries(entry.headers)) {
      headers[name] = expandEnvPlaceholders(value, env);
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export { expandEnvPlaceholders } from "./env-placeholders.js";

/** Test seam: read `client_information.redirect_uris[0]` from an on-disk OAuth store. */
export function redirectUrlFromStoredFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      client_information?: { redirect_uris?: unknown };
    };
    const list = parsed.client_information?.redirect_uris;
    if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  } catch {
    // ignore — placeholder will be used
  }
  return undefined;
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const name = (err as { name?: string } | null)?.name;
  return name === "UnauthorizedError";
}

function isHttpOrSse(entry: ServerEntry): boolean {
  return entry.type === "http" || entry.type === "sse";
}

function markNeedsAuth(
  upstreamServers: UpstreamServerInfo[],
  name: string,
  entry: ServerEntry,
): void {
  let info = upstreamServers.find((u) => u.name === name);
  if (!info) {
    info = { name };
    upstreamServers.push(info);
  }
  info.needsAuth = true;
  delete info.toolCount;
  if (entry.description) info.description = entry.description;
}

const defaultRefreshTokens: RefreshTokensFn = async (store) => {
  await refreshIfNeeded(store);
};
