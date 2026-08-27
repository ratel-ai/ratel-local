import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  buildGatewayFromConfig,
  type ConfigControlPlane,
  type ContextSnapshotResolver,
  createConfigControlPlane,
  createContextSnapshotResolver,
  createLocalGitExcludeManager,
  createMutationEngine,
  createPreparedChangeCoordinator,
  createProjectAdmissionLock,
  createProjectRegistry,
  createSkillDiscovery,
  createSkillImportControlPlane,
  createSkillRegistrationControlPlane,
  getAgentTraceStatus,
  loopbackTraceEndpoint,
  migrateLegacyOAuthStores,
  migrateLegacySkillLinks,
  type PreparedChangeCoordinator,
  type ProjectRegistry,
  prepareAgentTraceChange,
  type RuntimeContextRef,
  readJson,
  type SkillDiscovery,
  type SkillImportControlPlane,
  type SkillRegistrationControlPlane,
  writeJson,
} from "@ratel-ai/ratel-local-core";
import {
  init as initializeRatelTelemetry,
  type TelemetryHandle,
  type TelemetryInitOptions,
} from "@ratel-ai/telemetry-otlp";
import { createCloudCatalogSource } from "../../cloud/catalog.js";
import {
  CLOUD_API_KEY_ENV,
  type CloudOtlpTraceRelayOptions,
  cloudOtlpRelayOptionsFromEnv,
  cloudOtlpTraceRelayOptions,
  createCloudOtlpTraceRelayController,
  OTLP_LOGS_PATH,
  OTLP_TRACES_PATH,
} from "../../cloud/otlp-trace-relay.js";
import {
  CLOUD_PROFILE_ENV,
  type CloudSettings,
  CloudSettingsStore,
  type CloudSettingsStoreLike,
  cloudSettingsPath,
  DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT,
  legacyCloudSettingsPath,
  MIGRATED_PROFILE_NAME,
  resolveCloudCredential,
} from "../../cloud/settings.js";
import {
  authorizeDaemonRequest,
  DaemonAccessError,
  type DaemonRequestScope,
  ensureDaemonToken,
  readDaemonToken,
} from "../../daemon/access.js";
import { InMemoryMcpClientRegistry } from "../../daemon/client-registry.js";
import { createMcpHttpRoute } from "../../daemon/mcp-http.js";
import { ReconciledGatewayPool } from "../../daemon/reconciled-gateway-pool.js";
import {
  InMemoryScopedGatewayPool,
  type ResolvedGatewaySnapshot,
  type RetrievalHealthStats,
} from "../../daemon/scoped-gateway-pool.js";
import {
  applyFeatureFlagsToLaunchAgentPlist,
  applyFeatureFlagsToSystemdUserService,
} from "../../daemon/service-file.js";
import { DAEMON_INSTALL_PATH_ENV } from "../../daemon/subprocess-environment.js";
import {
  CLOUD_CATALOG_FEATURE_ENV,
  CLOUD_TELEMETRY_FEATURE_ENV,
  type FeatureFlags,
  featureFlagOverridesFromEnv,
  featureFlagServiceEnvironment,
  featureFlagsFromEnv,
} from "../../feature-flags.js";
import { openBrowser } from "../../ui/open-browser.js";
import { InMemoryUiSessionTokens, newSessionToken } from "../../ui/security.js";
import { startUiServer } from "../../ui/server.js";
import type { ParsedArgs } from "../args.js";
import { buildConfiguredGateway, type ServeOptions } from "./serve.js";
import type { HandlerCtx } from "./types.js";

export const DEFAULT_DAEMON_PORT = 5731;
export const DAEMON_LABEL = "ai.ratel.local.daemon";
export const SYSTEMD_SERVICE = "ratel-local-daemon.service";
export const DAEMON_SERVICE_ID = "ratel-local-daemon";
export const DAEMON_PROTOCOL_VERSION = 1;
export { DAEMON_INSTALL_PATH_ENV };

export const DAEMON_USAGE = `usage: ratel-local daemon [verb] [args...]

Verbs:
  run        run the daemon in the foreground (default)
  install    install and start the login service
  uninstall  stop and remove the login service
  status     probe the configured daemon endpoint
  start      start the installed login service
  stop       stop the installed login service
  restart    restart the installed login service
  open       open a fresh authenticated daemon UI session

Options:
  --port N     daemon port (defaults to 5731)
  --no-open    do not open the browser for foreground run`;

export interface RunDaemonResult {
  shutdown?: () => Promise<void>;
}

export interface DaemonState {
  pid: number;
  port: number;
  uiUrl: string;
  mcpUrl: string;
  startedAt: string;
  version: string;
  configMode: "auto" | "explicit" | "default";
}

export interface DaemonStatusBody extends DaemonState {
  service: typeof DAEMON_SERVICE_ID;
  protocolVersion: typeof DAEMON_PROTOCOL_VERSION;
  uptimeSeconds: number;
  upstreamCount: number;
  activeClientCount: number;
  activeGatewayCount: number;
  activeUserGatewayCount: number;
  activeProjectGatewayCount: number;
  retrievalHealth?: RetrievalHealthStats;
  /** Absent on daemons older than the restart-reconfiguration support. */
  cloudTelemetry?: boolean;
  cloudCatalog?: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type DaemonStartMode = "start" | "restart";
type ProbeDaemon = (
  port: number,
) => Promise<{ ok: boolean; reachable?: boolean; status?: DaemonStatusBody; error?: string }>;
type ConfigureRatelTelemetry = (
  options?: TelemetryInitOptions,
) => TelemetryHandle | Promise<TelemetryHandle>;

interface DaemonHandlerDeps {
  open?: typeof openBrowser;
  commandRunner?: CommandRunner;
  executablePath?: string;
  executableArgs?: string[];
  getUid?: () => number;
  now?: () => Date;
  platform?: NodeJS.Platform;
  probe?: ProbeDaemon;
  ensureToken?: (homeDir: string) => Promise<string>;
  projectRegistry?: ProjectRegistry;
  snapshotResolver?: ContextSnapshotResolver;
  readToken?: (homeDir: string) => Promise<string | null>;
  fetch?: typeof fetch;
  configControlPlane?: ConfigControlPlane;
  skillDiscovery?: SkillDiscovery;
  skillImportControlPlane?: SkillImportControlPlane;
  skillRegistrationControlPlane?: SkillRegistrationControlPlane;
  preparedChanges?: PreparedChangeCoordinator;
  cloudOtlpFetch?: typeof fetch;
  cloudCatalogFetch?: typeof fetch;
  configureRatelTelemetry?: ConfigureRatelTelemetry;
  cloudSettingsStore?: CloudSettingsStoreLike;
  lifecycleProgress?: boolean;
}

export interface DaemonServiceStatus {
  state: "running" | "stopped" | "not-installed";
  port: number;
  version?: string;
}

export async function runDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps = {},
): Promise<RunDaemonResult> {
  if (parsed.flags.help === true) {
    log(DAEMON_USAGE);
    return {};
  }

  const verb = parsed.verb ?? "run";
  if (verb === "run") {
    return runDaemonServer(parsed, ctx, options, log, opts);
  }
  if (verb === "install") {
    await runDaemonLifecycle(
      ctx,
      opts,
      {
        start: "Setting up Ratel Local…",
        success: "Ratel Local is ready",
        failure: "Ratel Local couldn't be set up",
      },
      () =>
        installDaemon(
          parsed,
          ctx,
          options,
          opts.lifecycleProgress === false ? log : () => {},
          opts,
        ),
    );
    return {};
  }
  if (verb === "uninstall") {
    await runDaemonLifecycle(
      ctx,
      opts,
      {
        start: "Removing Ratel Local…",
        success: "Ratel Local was removed",
        failure: "Ratel Local couldn't be removed",
      },
      () => uninstallDaemon(ctx, opts.lifecycleProgress === false ? log : () => {}, opts),
    );
    return {};
  }
  if (verb === "status") {
    await reportDaemonStatus(parsed, ctx, log, opts);
    return {};
  }
  if (verb === "start") {
    await runDaemonLifecycle(
      ctx,
      opts,
      {
        start: "Starting Ratel Local…",
        success: "Ratel Local is ready",
        failure: "Ratel Local couldn't start",
      },
      () =>
        startDaemon(parsed, ctx, options, opts.lifecycleProgress === false ? log : () => {}, opts),
    );
    return {};
  }
  if (verb === "stop") {
    await runDaemonLifecycle(
      ctx,
      opts,
      {
        start: "Stopping Ratel Local…",
        success: "Ratel Local is stopped",
        failure: "Ratel Local couldn't stop",
      },
      () => stopDaemon(ctx, opts.lifecycleProgress === false ? log : () => {}, opts),
    );
    return {};
  }
  if (verb === "restart") {
    let restartNote: string | undefined;
    await runDaemonLifecycle(
      ctx,
      opts,
      {
        start: "Restarting Ratel Local…",
        success: "Ratel Local is ready",
        failure: "Ratel Local couldn't restart",
      },
      async (spinner) => {
        const lifecycleLog = opts.lifecycleProgress === false ? log : () => {};
        const applied = await reconfigureInstalledServiceFeatureFlags(ctx, options, opts);
        await stopDaemon(ctx, lifecycleLog, opts);
        spinner?.message("Starting Ratel Local again…");
        await startDaemon(parsed, ctx, options, lifecycleLog, opts, "restart");
        if (applied !== undefined) {
          restartNote = await verifyFeatureFlagsApplied(
            await daemonPort(parsed, ctx),
            opts.probe ?? probeDaemon,
            applied,
          );
        }
      },
    );
    if (restartNote) log(restartNote);
    return {};
  }
  if (verb === "open") {
    await openDaemonUi(parsed, ctx, opts);
    return {};
  }
  throw new Error(`unknown daemon verb: ${verb}`);
}

async function runDaemonLifecycle(
  ctx: HandlerCtx,
  opts: DaemonHandlerDeps,
  copy: { start: string; success: string; failure: string },
  action: (spinner?: ReturnType<HandlerCtx["prompts"]["spinner"]>) => Promise<void>,
): Promise<void> {
  if (opts.lifecycleProgress === false) {
    await action();
    return;
  }
  const spinner = ctx.prompts.spinner();
  spinner.start(copy.start);
  try {
    await action(spinner);
    spinner.stop(copy.success);
  } catch (error) {
    spinner.stop(copy.failure);
    throw error;
  }
}

export async function inspectDaemonService(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  opts: DaemonHandlerDeps = {},
): Promise<DaemonServiceStatus> {
  const paths = daemonPaths(ctx.env.homeDir);
  const platform = daemonPlatform(opts);
  const installed =
    platform === "darwin"
      ? await ctx.fs.exists(paths.plist)
      : platform === "linux"
        ? await ctx.fs.exists(paths.systemdService)
        : false;
  if (!installed) {
    return { state: "not-installed", port: parseDaemonPort(parsed.flags.port) };
  }

  const port = await daemonPort(parsed, ctx);
  const persisted = await readDaemonState(ctx);
  const probe = await (opts.probe ?? probeDaemon)(port);
  if (probe.ok) {
    const version = probe.status?.version ?? persisted?.version;
    return { state: "running", port, ...(version ? { version } : {}) };
  }

  const version = persisted?.version;
  return {
    state: "stopped",
    port,
    ...(version ? { version } : {}),
  };
}

export async function runDaemonServer(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps = {},
): Promise<RunDaemonResult> {
  const port = parseDaemonPort(parsed.flags.port);
  const noOpen = parsed.flags.open === false;
  const token = newSessionToken();
  const uiSessions = new InMemoryUiSessionTokens([token]);
  const startedAt = (opts.now ?? (() => new Date()))();
  const registry = new InMemoryMcpClientRegistry();
  const projectRegistry =
    opts.projectRegistry ?? createProjectRegistry({ homeDir: ctx.env.homeDir });
  const projectAdmissionLock = createProjectAdmissionLock({
    controlDir: join(ctx.env.homeDir, ".ratel"),
  });
  const serverVersion = options.serverVersion ?? "0.0.0";
  const daemonProcessEnv = options.processEnv ?? process.env;
  const featureFlags = featureFlagsFromEnv(daemonProcessEnv);
  const retrievalHealthEnabled = daemonProcessEnv.RATEL_EXPERIMENTAL_RETRIEVAL_HEALTH === "1";
  const cloudSettingsStore =
    opts.cloudSettingsStore ??
    new CloudSettingsStore(
      cloudSettingsPath(ctx.env.homeDir),
      legacyCloudSettingsPath(ctx.env.homeDir),
      log,
    );
  // The credential belongs to the Cloud project, not to telemetry: it loads
  // whenever any Cloud consumer may need it, and each consumer keeps its own
  // gate (ADR-0021). Only the relay routes below stay behind the telemetry flag.
  let persistedCloudSettings: CloudSettings | undefined;
  try {
    persistedCloudSettings = await cloudSettingsStore.load();
  } catch (error) {
    log(`[ratel] ignored invalid Cloud settings: ${(error as Error).message}`);
  }
  const environmentCloudOptions = cloudOptionsFromEnvironment(daemonProcessEnv, log);
  const persistedCloudOptions = environmentCloudOptions
    ? undefined
    : cloudOptionsFromStore(persistedCloudSettings, daemonProcessEnv, log);
  let activeCloudOptions = environmentCloudOptions ?? persistedCloudOptions;
  const cloudOtlpRelay = createCloudOtlpTraceRelayController(
    featureFlags.cloudTelemetry && activeCloudOptions
      ? { ...activeCloudOptions, fetch: opts.cloudOtlpFetch, log }
      : undefined,
  );
  let ratelTelemetry: TelemetryHandle | undefined;
  let daemonPort = port;
  const ensureRatelTelemetry = async () => {
    if (ratelTelemetry || !featureFlags.cloudTelemetry || !activeCloudOptions) return;
    try {
      ratelTelemetry = await (opts.configureRatelTelemetry ?? initializeRatelTelemetry)({
        endpoint: `http://127.0.0.1:${daemonPort}${OTLP_TRACES_PATH}`,
        serviceName: "ratel-local",
      });
    } catch (error) {
      log(`[ratel] Ratel runtime telemetry disabled: ${(error as Error).message}`);
    }
  };
  const cloudCatalog = featureFlags.cloudCatalog
    ? createCloudCatalogSource({
        settings: persistedCloudSettings,
        environment: environmentCloudOptions,
        fallback: persistedCloudOptions,
        log,
        ...(opts.cloudCatalogFetch ? { fetch: opts.cloudCatalogFetch } : {}),
      })
    : undefined;
  const snapshotResolver =
    opts.snapshotResolver ??
    createContextSnapshotResolver({
      homeDir: ctx.env.homeDir,
      projectRegistry,
      ...(cloudCatalog ? { cloudCatalog } : {}),
    });
  const daemonToken = await (opts.ensureToken ?? ensureDaemonToken)(ctx.env.homeDir);
  const generationPool = new InMemoryScopedGatewayPool(async (scope) => {
    if (scope.resolvedContext) {
      return buildGatewayFromConfig(
        { mcpServers: {} },
        {
          transportFactory: options.transportFactory,
          logger: log,
          resolvedMcpEntries: scope.resolvedContext.mcpEntries,
          resolvedSkills: scope.resolvedContext.skills.effectiveSkills,
          ...(scope.resolvedContext.retrieval
            ? { retrieval: scope.resolvedContext.retrieval }
            : {}),
        },
      );
    }
    const scoped = scopeBuildInputs(parsed, ctx, options, scope);
    return (await buildConfiguredGateway(scoped.parsed, scoped.options, log)).gateway;
  }, log);
  const useResolvedControlPlane =
    options.readConfig === undefined && (isAutoConfig(parsed) || parsed.configPaths.length === 0);
  const mutationEngine = useResolvedControlPlane
    ? await createMutationEngine({ controlDir: join(ctx.env.homeDir, ".ratel") })
    : undefined;
  let publishPreparedContexts: (contexts: readonly RuntimeContextRef[]) => Promise<void> =
    async () => {};
  const preparedChanges =
    useResolvedControlPlane && mutationEngine
      ? (opts.preparedChanges ??
        createPreparedChangeCoordinator({
          mutationEngine,
          publish: async (contexts) => publishPreparedContexts(contexts),
        }))
      : undefined;
  // Recover any interrupted config ownership change before snapshots drive OAuth
  // migration; otherwise a transient half-transaction could mis-scope credentials.
  if (useResolvedControlPlane) {
    await migrateDaemonOAuthStores(ctx.env.homeDir, projectRegistry, snapshotResolver, log);
  }
  const localGitExcludeManager = useResolvedControlPlane
    ? createLocalGitExcludeManager()
    : undefined;
  const configControlPlane = useResolvedControlPlane
    ? (opts.configControlPlane ??
      (await createConfigControlPlane({
        homeDir: ctx.env.homeDir,
        projectRegistry,
        preparedChanges,
        localGitExcludeManager,
      })))
    : undefined;
  if (configControlPlane && preparedChanges) {
    try {
      const migration = await migrateLegacySkillLinks({
        homeDir: ctx.env.homeDir,
        configControlPlane,
        preparedChanges,
      });
      for (const id of migration?.result.migrated ?? []) {
        log(`[ratel] migrated legacy skill ${id} from symlink management to a scoped reference`);
      }
      for (const diagnostic of migration?.result.diagnostics ?? []) {
        log(`[ratel] legacy skill ${diagnostic.id} requires doctor --fix: ${diagnostic.message}`);
      }
    } catch (error) {
      log(
        `[ratel] automatic legacy skill migration skipped: ${(error as Error).message}; run ratel-local doctor --fix`,
      );
    }
  }
  const skillDiscovery = useResolvedControlPlane
    ? (opts.skillDiscovery ??
      createSkillDiscovery({
        homeDir: ctx.env.homeDir,
        registeredProjectRoots: async () =>
          (await projectRegistry.list()).map(({ canonicalRoot }) => canonicalRoot),
      }))
    : undefined;
  const skillImportControlPlane =
    useResolvedControlPlane && preparedChanges && skillDiscovery
      ? (opts.skillImportControlPlane ??
        createSkillImportControlPlane({
          homeDir: ctx.env.homeDir,
          projectRegistry,
          discovery: skillDiscovery,
          preparedChanges,
          localGitExcludeManager,
        }))
      : undefined;
  const skillRegistrationControlPlane =
    useResolvedControlPlane && preparedChanges && configControlPlane
      ? (opts.skillRegistrationControlPlane ??
        createSkillRegistrationControlPlane({
          homeDir: ctx.env.homeDir,
          projectRegistry,
          configControlPlane,
          snapshotResolver,
          preparedChanges,
          localGitExcludeManager,
        }))
      : undefined;
  const reconciledGatewayPool = useResolvedControlPlane
    ? new ReconciledGatewayPool({
        generations: generationPool,
        registry: projectRegistry,
        resolver: snapshotResolver,
        admissionLock: projectAdmissionLock,
        onRevision: (context, revision) => registry.setCurrentRevision(context, revision),
        onInvalidSnapshot: (context, error) => registry.setInvalidContext(context, error.message),
        log,
      })
    : undefined;
  publishPreparedContexts = async (contexts) => {
    if (!reconciledGatewayPool) return;
    const expanded = new Map<string, RuntimeContextRef>();
    for (const context of contexts) {
      expanded.set(context.kind === "global" ? "global" : `project:${context.projectId}`, context);
      if (context.kind === "global") {
        for (const client of registry.listActiveClients()) {
          expanded.set(
            client.context.kind === "global" ? "global" : `project:${client.context.projectId}`,
            client.context,
          );
        }
      }
    }
    for (const context of expanded.values()) {
      try {
        await reconciledGatewayPool.reconcileContext(context);
      } catch (error) {
        log(
          `[ratel] post-commit snapshot is invalid for ${
            context.kind === "global" ? "global" : context.projectId
          }: ${(error as Error).message}`,
        );
      }
    }
  };
  const gatewayPool = reconciledGatewayPool ?? generationPool;
  const mcp = createMcpHttpRoute({
    gatewayPool,
    daemonToken,
    registry,
    serverName: options.serverName ?? "ratel",
    serverVersion,
    log,
  });
  const stateForPort = (serverPort: number): DaemonState => ({
    pid: process.pid,
    port: serverPort,
    uiUrl: `http://127.0.0.1:${serverPort}`,
    mcpUrl: `http://127.0.0.1:${serverPort}/mcp`,
    startedAt: startedAt.toISOString(),
    version: serverVersion,
    configMode: configMode(parsed),
  });

  const ui = await startUiServer({
    ctx,
    token,
    port,
    activeMcpClients: registry,
    projectRegistry,
    projectAdmissionLock,
    canForgetProject: (project) =>
      !registry
        .listActiveClients()
        .some(
          (client) =>
            (client.context.kind === "project" && client.context.projectId === project.id) ||
            client.projectRoot === project.canonicalRoot,
        ) &&
      !gatewayPool
        .stats()
        .generations.some(
          (generation) =>
            generation.context.kind === "project" &&
            generation.context.projectId === project.id &&
            generation.activeLeaseCount > 0,
        ),
    configControlPlane,
    snapshotResolver,
    skillDiscovery,
    skillImportControlPlane,
    skillRegistrationControlPlane,
    preparedChanges,
    cloudTraceSettings: {
      featureEnabled: featureFlags.cloudTelemetry,
      status: async () => ({
        featureEnabled: featureFlags.cloudTelemetry,
        configured: featureFlags.cloudTelemetry && activeCloudOptions !== undefined,
        endpoint: activeCloudOptions?.endpoint.toString() ?? DEFAULT_CLOUD_OTLP_TRACES_ENDPOINT,
      }),
      save: async ({ endpoint, apiKey }) => {
        const retainedApiKey = apiKey?.trim() ? apiKey : activeCloudOptions?.apiKey;
        if (!retainedApiKey) throw new Error("Ratel Cloud API key is required");
        const next = cloudOtlpTraceRelayOptions({ endpoint, apiKey: retainedApiKey });
        // Writes the profile this daemon resolves to, so the single-credential
        // UI keeps working unchanged against a profile store.
        const profileName = persistedCloudSettings?.default ?? MIGRATED_PROFILE_NAME;
        persistedCloudSettings = {
          tracesEndpoint: next.endpoint.toString(),
          default: profileName,
          profiles: {
            ...persistedCloudSettings?.profiles,
            [profileName]: { apiKey: next.apiKey },
          },
        };
        await cloudSettingsStore.save(persistedCloudSettings);
        activeCloudOptions = next;
        cloudOtlpRelay.configure({ ...next, fetch: opts.cloudOtlpFetch, log });
        await ensureRatelTelemetry();
        log("[ratel] Ratel Cloud trace export configured");
        return {
          featureEnabled: featureFlags.cloudTelemetry,
          configured: featureFlags.cloudTelemetry,
          endpoint: next.endpoint.toString(),
        };
      },
    },
    agentTraceExporters: preparedChanges
      ? {
          featureEnabled: featureFlags.cloudTelemetry,
          status: async () => ({
            ...(await getAgentTraceStatus(ctx, {
              endpoint: loopbackTraceEndpoint(`http://127.0.0.1:${daemonPort}${OTLP_TRACES_PATH}`),
            })),
            cloudConfigured: featureFlags.cloudTelemetry && activeCloudOptions !== undefined,
            featureEnabled: featureFlags.cloudTelemetry,
          }),
          prepare: ({ action, level, hostKinds, overwrite }) =>
            prepareAgentTraceChange(ctx, {
              action,
              ...(level !== undefined ? { level } : {}),
              hostKinds,
              endpoint: loopbackTraceEndpoint(`http://127.0.0.1:${daemonPort}${OTLP_TRACES_PATH}`),
              ...(overwrite !== undefined ? { overwrite } : {}),
              preparedChanges,
            }),
        }
      : undefined,
    authenticateMcpServer: reconciledGatewayPool
      ? (context, authOptions) => reconciledGatewayPool.authenticate(context, authOptions)
      : undefined,
    daemonToken,
    sessionTokens: uiSessions,
    publicRoute: async (req, res, path) => {
      if (!featureFlags.cloudTelemetry && (path === OTLP_TRACES_PATH || path === OTLP_LOGS_PATH)) {
        req.resume();
        writePlain(res, 404, "Not found\n");
        return true;
      }
      if (featureFlags.cloudTelemetry && (await cloudOtlpRelay.handleRequest(req, res, path))) {
        return true;
      }
      if (req.method === "GET" && path === "/healthz") {
        if (!retrievalHealthEnabled) {
          writePlain(res, 200, "ok\n");
          return true;
        }
        const retrievalHealth = gatewayPool.stats().retrievalHealth;
        const ready = retrievalHealth.status === "ready";
        writePlain(
          res,
          ready ? 200 : 503,
          `${ready ? "ok" : "not ready"} retrieval=${retrievalHealth.status}\n`,
        );
        return true;
      }
      if (req.method === "GET" && path === "/api/daemon/status") {
        const requestPort = (req.socket.localPort as number | undefined) ?? port;
        const poolStats = gatewayPool.stats();
        writeJsonResponse(res, 200, {
          ...stateForPort(requestPort),
          service: DAEMON_SERVICE_ID,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
          upstreamCount: poolStats.upstreamCount,
          activeClientCount: registry.listActiveClients().length,
          activeGatewayCount: poolStats.activeGatewayCount,
          activeUserGatewayCount: poolStats.activeUserGatewayCount,
          activeProjectGatewayCount: poolStats.activeProjectGatewayCount,
          cloudTelemetry: featureFlags.cloudTelemetry,
          cloudCatalog: featureFlags.cloudCatalog,
          ...(retrievalHealthEnabled ? { retrievalHealth: poolStats.retrievalHealth } : {}),
        });
        return true;
      }
      if (req.method === "POST" && path === "/api/ui/sessions") {
        try {
          authorizeDaemonRequest(req.headers, daemonToken);
        } catch (error) {
          if (error instanceof DaemonAccessError) {
            writeJsonResponse(res, error.status, { error: error.message });
            return true;
          }
          throw error;
        }
        const requestPort = (req.socket.localPort as number | undefined) ?? port;
        const sessionToken = uiSessions.issue();
        writeJsonResponse(res, 201, {
          url: `http://127.0.0.1:${requestPort}/global/?t=${sessionToken}`,
        });
        return true;
      }
      if (path !== "/mcp") return false;
      await mcp.handleRequest(req, res);
      return true;
    },
  });

  daemonPort = ui.port;
  await ensureRatelTelemetry();

  const state = stateForPort(ui.port);
  await writeDaemonState(ctx, state);

  // Never persist the bearer-bearing UI URL in service logs. `daemon open`
  // obtains a fresh in-memory session through the daemon-token exchange.
  log(`[ratel] daemon running at ${state.uiUrl}`);
  log(`[ratel] daemon UI: ${state.uiUrl}`);
  log(`[ratel] MCP HTTP endpoint: ${state.mcpUrl}`);
  if (featureFlags.cloudTelemetry) {
    log(`[ratel] Cloud OTLP trace endpoint available at ${state.uiUrl}${OTLP_TRACES_PATH}`);
    log(`[ratel] Cloud OTLP log endpoint available at ${state.uiUrl}${OTLP_LOGS_PATH}`);
  } else {
    log(
      `[ratel] Cloud telemetry disabled; start a foreground daemon with ${CLOUD_TELEMETRY_FEATURE_ENV}=1 or run ${CLOUD_TELEMETRY_FEATURE_ENV}=1 ratel-local daemon restart`,
    );
  }
  if (featureFlags.cloudTelemetry && activeCloudOptions) {
    log("[ratel] Ratel Cloud trace export configured");
    log("[ratel] Ratel runtime Cloud trace export enabled");
  }
  log("[ratel] ready for scoped MCP clients");
  log("[ratel] Press Ctrl-C to stop.");

  if (!noOpen) {
    (opts.open ?? openBrowser)(ui.url);
  }

  return {
    shutdown: async () => {
      try {
        await mcp.shutdown();
        await ui.shutdown();
        await gatewayPool.shutdown();
      } finally {
        await ratelTelemetry?.shutdown();
      }
    },
  };
}

async function migrateDaemonOAuthStores(
  homeDir: string,
  registry: ProjectRegistry,
  resolver: ContextSnapshotResolver,
  log: (message: string) => void,
): Promise<void> {
  const contexts = [
    { kind: "global" as const },
    ...(await registry.list())
      .filter(({ status }) => status === "available")
      .map(({ id }) => ({ kind: "project" as const, projectId: id })),
  ];
  const entries = [];
  for (const context of contexts) {
    try {
      entries.push(...(await resolver.resolve(context)).mcpEntries);
    } catch (error) {
      log(
        `[ratel] skipped OAuth migration because a context is invalid: ${(error as Error).message}`,
      );
      return;
    }
  }
  try {
    const report = await migrateLegacyOAuthStores({ homeDir, entries });
    for (const item of report.migrated) {
      log(`[ratel] migrated legacy OAuth state for ${item.serverName}`);
    }
    for (const diagnostic of report.diagnostics) {
      log(`[ratel] ${diagnostic.message}`);
    }
  } catch (error) {
    log(`[ratel] OAuth migration failed safely: ${(error as Error).message}`);
  }
}

async function openDaemonUi(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const port = await daemonPort(parsed, ctx);
  const daemonToken = await (opts.readToken ?? readDaemonToken)(ctx.env.homeDir);
  if (!daemonToken) throw new Error('daemon token is missing; run "ratel-local daemon install"');
  const response = await (opts.fetch ?? fetch)(`http://127.0.0.1:${port}/api/ui/sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${daemonToken}` },
  });
  if (!response.ok) {
    throw new Error(`daemon refused UI session: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("daemon returned an invalid UI session");
  await (opts.open ?? openBrowser)(body.url);
}

function isAutoConfig(parsed: ParsedArgs): boolean {
  return parsed.flags["auto-config"] === true || parsed.flags["auto-config"] === "true";
}

function scopeBuildInputs(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  scope: DaemonRequestScope | ResolvedGatewaySnapshot,
): { parsed: ParsedArgs; options: ServeOptions } {
  const autoConfig = parsed.flags["auto-config"];
  if (autoConfig !== true && autoConfig !== "true") {
    return { parsed, options };
  }
  const flags = { ...parsed.flags };
  if (scope.kind === "project") flags["project-root"] = scope.projectRoot;
  else delete flags["project-root"];
  const processEnv = { ...(options.processEnv ?? process.env) };
  delete processEnv.RATEL_PROJECT_ROOT;
  delete processEnv.CLAUDE_PROJECT_DIR;
  return {
    parsed: { ...parsed, flags },
    options: {
      ...options,
      env: { homeDir: ctx.env.homeDir },
      processEnv,
      cwd: scope.kind === "project" ? scope.projectRoot : ctx.env.homeDir,
      ...(scope.kind !== "project" ? { existsSync: () => false } : {}),
    },
  };
}

/**
 * The ADR 0013 single-run override. Consumes the key and scrubs it from the
 * environment either way, so no subprocess can inherit it.
 */
function cloudOptionsFromEnvironment(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): CloudOtlpTraceRelayOptions | undefined {
  try {
    return cloudOtlpRelayOptionsFromEnv(env);
  } catch (error) {
    log(`[ratel] ignored invalid Cloud environment: ${(error as Error).message}`);
    return undefined;
  } finally {
    delete env[CLOUD_API_KEY_ENV];
  }
}

/**
 * The credential this daemon uses. `RATEL_PROFILE` selects one by name for a
 * foreground run; an installed service has one environment, so per-project
 * selection arrives with the per-scope consumer, not here.
 */
function cloudOptionsFromStore(
  settings: CloudSettings | undefined,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): CloudOtlpTraceRelayOptions | undefined {
  if (!settings) return undefined;
  const selected = env[CLOUD_PROFILE_ENV];
  try {
    const resolved = resolveCloudCredential(settings, {
      ...(selected ? { profile: selected } : {}),
      source: selected ? `${CLOUD_PROFILE_ENV} environment` : "store default",
    });
    if (!resolved) return undefined;
    return cloudOtlpTraceRelayOptions({
      endpoint: resolved.tracesEndpoint,
      apiKey: resolved.apiKey,
    });
  } catch (error) {
    log(`[ratel] no Cloud credential resolved: ${(error as Error).message}`);
    return undefined;
  }
}

export function daemonPaths(homeDir: string) {
  const ratelDir = join(homeDir, ".ratel");
  const logsDir = join(ratelDir, "logs");
  return {
    ratelDir,
    logsDir,
    state: join(ratelDir, "daemon.json"),
    stdoutLog: join(logsDir, "daemon.log"),
    stderrLog: join(logsDir, "daemon.err.log"),
    launchAgentsDir: join(homeDir, "Library", "LaunchAgents"),
    plist: join(homeDir, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`),
    systemdUserDir: join(homeDir, ".config", "systemd", "user"),
    systemdService: join(homeDir, ".config", "systemd", "user", SYSTEMD_SERVICE),
  };
}

export function createLaunchAgentPlist(input: {
  executablePath: string;
  executableArgs?: string[];
  homeDir: string;
  port: number;
  pathEnv?: string;
  featureFlags?: FeatureFlags;
}): string {
  const paths = daemonPaths(input.homeDir);
  const args = [
    input.executablePath,
    ...(input.executableArgs ?? []),
    "daemon",
    "run",
    "--port",
    String(input.port),
    "--no-open",
    "--auto-config",
  ];
  const serviceEnvironment = {
    ...(input.pathEnv ? { PATH: input.pathEnv, [DAEMON_INSTALL_PATH_ENV]: input.pathEnv } : {}),
    ...featureFlagServiceEnvironment(
      input.featureFlags ?? { cloudTelemetry: false, cloudCatalog: false },
    ),
  };
  const environmentXml = Object.entries(serviceEnvironment)
    .map(
      ([key, value]) =>
        `    <key>${escapePlist(key)}</key>\n    <string>${escapePlist(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(DAEMON_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapePlist(input.homeDir)}</string>
${
  environmentXml
    ? `  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
`
    : ""
}  <key>StandardOutPath</key>
  <string>${escapePlist(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(paths.stderrLog)}</string>
</dict>
</plist>
`;
}

export function createSystemdUserService(input: {
  executablePath: string;
  executableArgs?: string[];
  homeDir: string;
  port: number;
  pathEnv?: string;
  featureFlags?: FeatureFlags;
}): string {
  const paths = daemonPaths(input.homeDir);
  const command = [input.executablePath, ...(input.executableArgs ?? [])]
    .map(systemdQuote)
    .join(" ");
  const serviceEnvironment = {
    ...(input.pathEnv ? { PATH: input.pathEnv, [DAEMON_INSTALL_PATH_ENV]: input.pathEnv } : {}),
    ...featureFlagServiceEnvironment(
      input.featureFlags ?? { cloudTelemetry: false, cloudCatalog: false },
    ),
  };
  const environmentLines = Object.entries(serviceEnvironment)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Ratel Local daemon
After=network.target

[Service]
Type=simple
ExecStart=${command} daemon run --port ${input.port} --no-open --auto-config
WorkingDirectory=${systemdQuote(input.homeDir)}
${environmentLines ? `${environmentLines}\n` : ""}Restart=always
RestartSec=2
StandardOutput=append:${systemdPath(paths.stdoutLog)}
StandardError=append:${systemdPath(paths.stderrLog)}

[Install]
WantedBy=default.target
`;
}

/**
 * Apply an explicit Cloud telemetry override to the installed service file.
 * Returns the applied value, or `undefined` when nothing was written — no
 * override in the environment, or no installed service to rewrite.
 */
async function reconfigureInstalledServiceFeatureFlags(
  ctx: HandlerCtx,
  options: ServeOptions,
  opts: DaemonHandlerDeps,
): Promise<Readonly<Record<string, boolean>> | undefined> {
  const overrides = featureFlagOverridesFromEnv(options.processEnv ?? process.env);
  if (Object.keys(overrides).length === 0) return undefined;
  const platform = daemonPlatform(opts);
  const paths = daemonPaths(ctx.env.homeDir);
  const servicePath = platform === "linux" ? paths.systemdService : paths.plist;
  const current = await ctx.fs.read(servicePath);
  if (current === null) return undefined;
  const next =
    platform === "linux"
      ? applyFeatureFlagsToSystemdUserService(current, overrides)
      : applyFeatureFlagsToLaunchAgentPlist(current, overrides);
  if (next !== current) {
    await ctx.fs.writeAtomic(servicePath, next);
    if (platform === "linux") await systemctl(opts, ["daemon-reload"]);
  }
  return overrides;
}

/**
 * Confirm the restarted daemon actually runs with the flag we just wrote.
 * Rewriting the service file is not proof: launchd or systemd may still be
 * serving the previous definition. Throws on a mismatch; returns a note when
 * the running daemon is too old to report the flag at all.
 */
/** Which status field reports each flag a service file can carry. */
const FLAG_STATUS_FIELD: Record<string, keyof DaemonStatusBody> = {
  [CLOUD_TELEMETRY_FEATURE_ENV]: "cloudTelemetry",
  [CLOUD_CATALOG_FEATURE_ENV]: "cloudCatalog",
};

async function verifyFeatureFlagsApplied(
  port: number,
  probe: ProbeDaemon,
  expected: Readonly<Record<string, boolean>>,
): Promise<string | undefined> {
  const result = await probe(port);
  const unconfirmed = (reason: string) =>
    `[ratel] could not confirm the requested feature flags: ${reason}. Check "ratel-local traces status".`;
  if (!result.ok) return unconfirmed("the daemon did not answer");
  const unreported: string[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const observed = result.status?.[FLAG_STATUS_FIELD[name] as keyof DaemonStatusBody];
    if (observed === want) continue;
    if (observed === undefined) {
      unreported.push(name);
      continue;
    }
    throw new Error(
      `service was updated but the restarted daemon reports ${name} ${observed ? "enabled" : "disabled"}, expected ${want ? "enabled" : "disabled"}; the previous service definition may still be loaded. Reinstall with "ratel-local daemon uninstall" then "${name}=${want ? "1" : "0"} ratel-local daemon install".`,
    );
  }
  return unreported.length > 0
    ? unconfirmed(`the running daemon does not report ${unreported.join(", ")}`)
    : undefined;
}

async function installDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await installLinuxDaemon(parsed, ctx, options, log, opts);
    return;
  }
  ensureMacos("daemon install", opts);
  const port = parsePersistentDaemonPort(parsed.flags.port);
  await assertDaemonPortAvailable(port, opts.probe ?? probeDaemon);
  const paths = daemonPaths(ctx.env.homeDir);
  await ctx.fs.mkdirp(paths.logsDir);
  await ctx.fs.mkdirp(paths.launchAgentsDir);
  await ctx.fs.writeAtomic(
    paths.plist,
    createLaunchAgentPlist({
      executablePath: opts.executablePath ?? process.argv[1] ?? "ratel-local",
      executableArgs: opts.executableArgs,
      homeDir: ctx.env.homeDir,
      port,
      pathEnv: (options.processEnv ?? process.env).PATH,
      featureFlags: featureFlagsFromEnv(options.processEnv ?? process.env),
    }),
  );
  await bootstrapDaemon(ctx, opts);
  await kickstartDaemon(ctx, opts);
  await waitForDaemon(port, opts.probe ?? probeDaemon, options.serverVersion);
  log(`[ratel] daemon installed: ${paths.plist}`);
  log(`[ratel] daemon UI: http://127.0.0.1:${port}`);
  log(`[ratel] MCP HTTP endpoint: http://127.0.0.1:${port}/mcp`);
}

async function uninstallDaemon(
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await uninstallLinuxDaemon(ctx, log, opts);
    return;
  }
  ensureMacos("daemon uninstall", opts);
  await bootoutDaemon(ctx, opts, { ignoreFailure: true });
  const paths = daemonPaths(ctx.env.homeDir);
  await ctx.fs.remove(paths.plist);
  await ctx.fs.remove(paths.state);
  log(`[ratel] daemon uninstalled: ${paths.plist}`);
}

async function startDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
  mode: DaemonStartMode = "start",
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await startLinuxDaemon(parsed, ctx, options, log, opts, mode);
    return;
  }
  ensureMacos("daemon start", opts);
  const paths = daemonPaths(ctx.env.homeDir);
  if (!(await ctx.fs.exists(paths.plist))) {
    throw new Error(`daemon is not installed; run "ratel-local daemon install" first`);
  }
  const port = await daemonPort(parsed, ctx);
  const probe = opts.probe ?? probeDaemon;
  if ((await probe(port)).ok) {
    if (mode === "start") {
      log(`[ratel] daemon already running at http://127.0.0.1:${port}`);
      return;
    }
    await waitForDaemonStopped(port, probe);
  }
  await bootstrapDaemon(ctx, opts, { ignoreFailure: true });
  await kickstartDaemon(ctx, opts);
  await waitForDaemon(port, probe, options.serverVersion);
  log(`[ratel] daemon started at http://127.0.0.1:${port}`);
}

async function stopDaemon(
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await stopLinuxDaemon(log, opts);
    return;
  }
  ensureMacos("daemon stop", opts);
  await bootoutDaemon(ctx, opts, { ignoreFailure: true });
  log("[ratel] daemon stopped");
}

async function installLinuxDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const port = parsePersistentDaemonPort(parsed.flags.port);
  await assertDaemonPortAvailable(port, opts.probe ?? probeDaemon);
  const paths = daemonPaths(ctx.env.homeDir);
  await ctx.fs.mkdirp(paths.logsDir);
  await ctx.fs.mkdirp(paths.systemdUserDir);
  await ctx.fs.writeAtomic(
    paths.systemdService,
    createSystemdUserService({
      executablePath: opts.executablePath ?? process.argv[1] ?? "ratel-local",
      executableArgs: opts.executableArgs,
      homeDir: ctx.env.homeDir,
      port,
      pathEnv: (options.processEnv ?? process.env).PATH,
      featureFlags: featureFlagsFromEnv(options.processEnv ?? process.env),
    }),
  );
  await systemctl(opts, ["daemon-reload"]);
  await systemctl(opts, ["enable", "--now", SYSTEMD_SERVICE]);
  await waitForDaemon(port, opts.probe ?? probeDaemon, options.serverVersion);
  log(`[ratel] daemon installed: ${paths.systemdService}`);
  log(`[ratel] daemon UI: http://127.0.0.1:${port}`);
  log(`[ratel] MCP HTTP endpoint: http://127.0.0.1:${port}/mcp`);
}

async function uninstallLinuxDaemon(
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const paths = daemonPaths(ctx.env.homeDir);
  await systemctl(opts, ["disable", "--now", SYSTEMD_SERVICE], { ignoreFailure: true });
  await ctx.fs.remove(paths.systemdService);
  await ctx.fs.remove(paths.state);
  await systemctl(opts, ["daemon-reload"], { ignoreFailure: true });
  log(`[ratel] daemon uninstalled: ${paths.systemdService}`);
}

async function startLinuxDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
  mode: DaemonStartMode = "start",
): Promise<void> {
  const paths = daemonPaths(ctx.env.homeDir);
  if (!(await ctx.fs.exists(paths.systemdService))) {
    throw new Error(`daemon is not installed; run "ratel-local daemon install" first`);
  }
  const port = await daemonPort(parsed, ctx);
  const probe = opts.probe ?? probeDaemon;
  if ((await probe(port)).ok) {
    if (mode === "start") {
      log(`[ratel] daemon already running at http://127.0.0.1:${port}`);
      return;
    }
    await waitForDaemonStopped(port, probe);
  }
  await systemctl(opts, ["start", SYSTEMD_SERVICE]);
  await waitForDaemon(port, probe, options.serverVersion);
  log(`[ratel] daemon started at http://127.0.0.1:${port}`);
}

async function stopLinuxDaemon(log: (m: string) => void, opts: DaemonHandlerDeps): Promise<void> {
  await systemctl(opts, ["stop", SYSTEMD_SERVICE], { ignoreFailure: true });
  log("[ratel] daemon stopped");
}

async function reportDaemonStatus(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const state = await readDaemonState(ctx);
  const port = await daemonPort(parsed, ctx);
  const probe = await (opts.probe ?? probeDaemon)(port);
  if (probe.ok) {
    const status = probe.status;
    log(`[ratel] daemon running at http://127.0.0.1:${port}`);
    log(`[ratel] MCP HTTP endpoint: http://127.0.0.1:${port}/mcp`);
    if (status) {
      log(
        `[ratel] pid ${status.pid}, ${status.upstreamCount} upstream server(s), ${status.activeClientCount} active MCP client(s)`,
      );
    } else if (state) {
      log(`[ratel] pid ${state.pid}`);
    }
    return;
  }
  if (state) {
    log(`[ratel] daemon not responding at http://127.0.0.1:${port} (stale pid ${state.pid})`);
    return;
  }
  log(`[ratel] daemon not running at http://127.0.0.1:${port}`);
}

async function writeDaemonState(ctx: HandlerCtx, state: DaemonState): Promise<void> {
  await ctx.fs.mkdirp(daemonPaths(ctx.env.homeDir).ratelDir);
  await writeJson(ctx.fs, daemonPaths(ctx.env.homeDir).state, state);
}

async function readDaemonState(ctx: HandlerCtx): Promise<DaemonState | null> {
  const path = daemonPaths(ctx.env.homeDir).state;
  try {
    return await readJson<DaemonState>(ctx.fs, path);
  } catch {
    return null;
  }
}

async function daemonPort(parsed: ParsedArgs, ctx: HandlerCtx): Promise<number> {
  if (parsed.flags.port !== undefined) return parseDaemonPort(parsed.flags.port);
  return (await readDaemonState(ctx))?.port ?? DEFAULT_DAEMON_PORT;
}

async function bootstrapDaemon(
  ctx: HandlerCtx,
  opts: DaemonHandlerDeps,
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  await launchctl(
    ctx,
    opts,
    ["bootstrap", launchdDomain(opts), daemonPaths(ctx.env.homeDir).plist],
    options,
  );
}

async function kickstartDaemon(ctx: HandlerCtx, opts: DaemonHandlerDeps): Promise<void> {
  await launchctl(ctx, opts, ["kickstart", "-k", `${launchdDomain(opts)}/${DAEMON_LABEL}`]);
}

async function bootoutDaemon(
  ctx: HandlerCtx,
  opts: DaemonHandlerDeps,
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  await launchctl(
    ctx,
    opts,
    ["bootout", launchdDomain(opts), daemonPaths(ctx.env.homeDir).plist],
    options,
  );
}

async function launchctl(
  _ctx: HandlerCtx,
  opts: DaemonHandlerDeps,
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  try {
    await (opts.commandRunner ?? runCommand)("launchctl", args);
  } catch (err) {
    if (options.ignoreFailure) return;
    throw err;
  }
}

async function systemctl(
  opts: DaemonHandlerDeps,
  args: string[],
  options: { ignoreFailure?: boolean } = {},
): Promise<void> {
  try {
    await (opts.commandRunner ?? runCommand)("systemctl", ["--user", ...args]);
  } catch (err) {
    if (options.ignoreFailure) return;
    throw new Error(
      `${(err as Error).message}\nUser-level systemd is required on Linux. You can still run "ratel-local daemon run --port ${DEFAULT_DAEMON_PORT} --no-open --auto-config" manually.`,
    );
  }
}

async function assertDaemonPortAvailable(port: number, probe: ProbeDaemon): Promise<void> {
  const result = await probe(port);
  if (result.ok) {
    throw new Error(
      `port ${port} already serves a Ratel daemon${
        result.status?.version ? ` version ${result.status.version}` : ""
      }; stop it before installing the login service`,
    );
  }
  if (result.reachable) {
    throw new Error(
      `port ${port} is occupied by a service that is not a compatible Ratel daemon: ${
        result.error ?? "identity check failed"
      }`,
    );
  }
}

/**
 * Wait for a stopped daemon to release its port. `daemon restart` rewrites the
 * installed service definition before stopping, and `start` hands back a
 * still-running daemon untouched — so starting before the old process is gone
 * would silently keep the pre-rewrite definition live.
 */
export async function waitForDaemonStopped(
  port: number,
  probe: ProbeDaemon,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(port)).ok) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `daemon at http://127.0.0.1:${port} did not stop; restart cannot apply service changes`,
  );
}

async function waitForDaemon(
  port: number,
  probe: ProbeDaemon,
  expectedVersion?: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError = "not responding";
  while (Date.now() < deadline) {
    const result = await probe(port);
    if (result.ok && (!expectedVersion || result.status?.version === expectedVersion)) return;
    if (result.ok && expectedVersion) {
      lastError = `expected version ${expectedVersion}, got ${result.status?.version ?? "unknown"}`;
    }
    lastError = result.error ?? lastError;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `daemon did not become healthy at http://127.0.0.1:${port}/healthz: ${lastError}`,
  );
}

async function probeDaemon(port: number): Promise<{
  ok: boolean;
  reachable?: boolean;
  status?: DaemonStatusBody;
  error?: string;
}> {
  const statusUrl = `http://127.0.0.1:${port}/api/daemon/status`;
  try {
    const statusRes = await fetchWithTimeout(statusUrl);
    if (!statusRes.ok) {
      return {
        ok: false,
        reachable: true,
        error: `status endpoint returned HTTP ${statusRes.status}`,
      };
    }
    const body = (await statusRes.json().catch(() => null)) as unknown;
    if (!isDaemonStatusBody(body, port)) {
      return {
        ok: false,
        reachable: true,
        error: "status endpoint did not return the Ratel daemon identity",
      };
    }
    return { ok: true, reachable: true, status: body };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function isDaemonStatusBody(value: unknown, port: number): value is DaemonStatusBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    body.service === DAEMON_SERVICE_ID &&
    body.protocolVersion === DAEMON_PROTOCOL_VERSION &&
    body.port === port &&
    typeof body.pid === "number" &&
    typeof body.version === "string"
  );
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const message = stderr || (err as Error).message;
        reject(new Error(`${command} ${args.join(" ")} failed: ${message.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function launchdDomain(opts: DaemonHandlerDeps): string {
  return `gui/${(opts.getUid ?? defaultUid)()}`;
}

function defaultUid(): number {
  const uid = process.getuid?.();
  if (uid !== undefined) return uid;
  const envUid = Number(process.env.UID);
  if (Number.isInteger(envUid)) return envUid;
  throw new Error("cannot determine user id for launchctl domain");
}

function ensureMacos(action: string, opts: DaemonHandlerDeps): void {
  const platform = daemonPlatform(opts);
  if (platform !== "darwin") {
    throw new Error(
      `${action} service management is currently implemented on macOS and Linux only`,
    );
  }
}

function daemonPlatform(opts: DaemonHandlerDeps): NodeJS.Platform {
  return opts.platform ?? process.platform;
}

function parseDaemonPort(raw: unknown): number {
  if (raw === undefined || raw === true || raw === false) return DEFAULT_DAEMON_PORT;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer in [0, 65535], got "${raw}"`);
  }
  return n;
}

function parsePersistentDaemonPort(raw: unknown): number {
  const port = parseDaemonPort(raw);
  if (port === 0) {
    throw new Error(
      "--port 0 is only valid for foreground daemon runs; login services need a stable port",
    );
  }
  return port;
}

function configMode(parsed: ParsedArgs): DaemonState["configMode"] {
  if (parsed.flags["auto-config"] === true) return "auto";
  if (parsed.configPaths.length > 0) return "explicit";
  return "auto";
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function systemdPath(value: string): string {
  return value.replaceAll("\\", "\\\\");
}

function writeJsonResponse(
  res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writePlain(
  res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  body: string,
): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}
