import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import {
  findAgentHostRatelPluginConnection,
  NamedAgentHostAdapter,
  SUPPORTED_AGENT_HOSTS,
  type SupportedAgentHostKind,
} from "@ratel-ai/ratel-local-core";
import { featureFlagsFromEnv } from "../../feature-flags.js";
import type { ParsedArgs } from "../args.js";
import { inspectDaemonService, runDaemon } from "./daemon.js";
import { runImport } from "./import.js";
import { runLink } from "./link.js";
import type { ServeOptions } from "./serve.js";
import { runTraces } from "./traces.js";
import type { HandlerCtx } from "./types.js";

export const SETUP_USAGE = `usage: ratel-local setup [options]

Install or update the daemon, connect supported agents, and optionally import
their existing MCP servers and skills.

Options:
  --agent auto|claude-code|codex
              connect an agent; repeat for multiple agents
  --daemon-only
              install/update/start only; skip agent onboarding
  --traces    enable native trace export for selected agents after onboarding;
              with --yes, explicit --agent values are required
  --overwrite-traces
              irreversibly replace conflicting exporters (requires --traces)
  --yes       accept daemon actions and explicitly selected agent links;
              never imports MCPs automatically; never enables traces unless requested
  --port N    choose the daemon port for first installation (default: 5731)
  --help      show this help

Native trace setup is experimental and is offered only when setup is invoked
with RATEL_FEATURE_CLOUD_TELEMETRY=1. The running daemon must have the same
feature enabled.`;

export type SetupDaemonState = "running" | "stopped" | "not-installed";

export interface SetupDaemonStatus {
  state: SetupDaemonState;
  port: number;
  version?: string;
}

export interface SetupResult extends SetupDaemonStatus {
  changed: boolean;
}

export interface SetupOptions extends ServeOptions {
  yes?: boolean;
  agentKinds?: readonly SupportedAgentHostKind[];
  agentsProvided?: boolean;
  daemonOnly?: boolean;
  traces?: boolean;
  overwriteTraces?: boolean;
  expectedVersion?: string;
  inspect?: (parsed: ParsedArgs) => Promise<SetupDaemonStatus>;
  install?: () => Promise<void>;
  start?: () => Promise<void>;
  upgrade?: (port: number) => Promise<void>;
  serviceExecutable?: SetupServiceExecutable;
  detectAgents?: (ctx: HandlerCtx) => Promise<SetupAgentDetection[]>;
  linkAgent?: (ctx: HandlerCtx, agentKind: SupportedAgentHostKind) => Promise<void>;
  importAgent?: (ctx: HandlerCtx, agentKind: SupportedAgentHostKind) => Promise<void>;
  configureAgentTraces?: (
    ctx: HandlerCtx,
    agentKinds: readonly SupportedAgentHostKind[],
    options: { overwrite: boolean; yes: boolean },
  ) => Promise<void>;
}

export interface SetupAgentDetection {
  kind: SupportedAgentHostKind;
  displayName: string;
  present: boolean;
  reasons: string[];
  warnings: string[];
}

export interface SetupServiceExecutable {
  executablePath: string;
  executableArgs?: string[];
}

export interface SetupServiceExecutableInput {
  expectedVersion?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  argv1?: string;
  isExecutable?: (path: string) => boolean;
}

export async function runSetup(ctx: HandlerCtx, options: SetupOptions = {}): Promise<SetupResult> {
  ctx.prompts.intro("Set up Ratel Local");
  ctx.prompts.note(
    "Ratel Local runs quietly in the background, so your coding agents can use it whenever they need it. Each project keeps its own tools and settings.",
    "What to expect",
  );

  const inspectService = options.inspect ?? ((parsed) => inspectDaemonService(parsed, ctx));
  const inspect = () => inspectForSetup(ctx.argv, inspectService);
  const quietLifecycleLog = () => {};
  const install =
    options.install ??
    (() => runDaemonCommand("install", ctx, options, undefined, quietLifecycleLog));
  const start =
    options.start ?? (() => runDaemonCommand("start", ctx, options, undefined, quietLifecycleLog));
  const upgrade =
    options.upgrade ??
    (async (port: number) => {
      await runDaemonCommand("uninstall", ctx, options, undefined, quietLifecycleLog);
      await runDaemonCommand("install", ctx, options, port, quietLifecycleLog);
    });
  const daemon = await ensureDaemon(ctx, options, { inspect, install, start, upgrade });
  if (!daemon.ready) return daemon.result;

  if (options.daemonOnly) {
    ctx.prompts.outro("You're all set — Ratel Local is ready.");
    return daemon.result;
  }

  const onboarding = await onboardAgents(ctx, options);
  if (onboarding.cancelled) return daemon.result;
  await onboardAgentTraces(ctx, options, onboarding.connected);
  ctx.prompts.outro(
    onboarding.connected.length > 0
      ? "You're all set — Ratel Local is ready and your agents are connected."
      : "You're all set — Ratel Local is ready.",
  );
  return daemon.result;
}

async function onboardAgentTraces(
  ctx: HandlerCtx,
  options: SetupOptions,
  connected: SupportedAgentHostKind[],
): Promise<void> {
  if (connected.length === 0) return;
  const cloudTelemetryEnabled = featureFlagsFromEnv(
    options.processEnv ?? process.env,
  ).cloudTelemetry;
  if (!cloudTelemetryEnabled && !options.traces) return;
  let selected: SupportedAgentHostKind[];
  if (options.yes) {
    if (!options.traces) {
      ctx.prompts.note(
        "Native trace exporters were left unchanged. Automation must pass `--yes --traces --agent <agent>` explicitly.",
        "Safe automation",
      );
      return;
    }
    selected = connected;
  } else if (options.traces) {
    selected = connected;
  } else {
    const picked = await ctx.prompts.multiselect<SupportedAgentHostKind>({
      message: "Enable native trace export through Ratel for which agents?",
      options: connected.map((kind) => ({
        value: kind,
        label: agentDisplayName(kind),
        hint: "Requires a new agent session; Cloud setup can be added later.",
      })),
      initialValues: [],
      required: false,
    });
    if (ctx.prompts.isCancel(picked)) {
      ctx.prompts.note("Skipped native trace exporter setup.", "Traces");
      return;
    }
    selected = dedupeAgentKinds(picked as SupportedAgentHostKind[]);
  }
  if (selected.length === 0) return;

  const configure =
    options.configureAgentTraces ??
    ((targetCtx, agentKinds, traceOptions) =>
      runTraces(
        {
          ...targetCtx,
          argv: {
            group: "traces",
            verb: "enable",
            configPaths: [],
            rest: [],
            extras: [],
            flags: {
              agent: [...agentKinds],
              yes: traceOptions.yes,
              overwrite: traceOptions.overwrite,
            },
          },
        },
        { overwriteFlagName: "--overwrite-traces" },
      ));
  await configure(ctx, selected, {
    overwrite: options.overwriteTraces ?? false,
    yes: options.yes ?? false,
  });
}

async function ensureDaemon(
  ctx: HandlerCtx,
  options: SetupOptions,
  actions: {
    inspect: () => Promise<SetupDaemonStatus>;
    install: () => Promise<void>;
    start: () => Promise<void>;
    upgrade: (port: number) => Promise<void>;
  },
): Promise<{ result: SetupResult; ready: boolean }> {
  const status = await actions.inspect();
  if (
    status.state !== "not-installed" &&
    options.expectedVersion &&
    status.version !== options.expectedVersion
  ) {
    const currentVersion = status.version ?? "unknown";
    const confirmed = options.yes
      ? true
      : await ctx.prompts.confirm({
          message: `Update Ratel Local from ${currentVersion} to ${options.expectedVersion}? Your projects and settings will stay the same.`,
          initialValue: true,
        });
    if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
      ctx.prompts.cancel("setup cancelled");
      return { result: { ...status, changed: false }, ready: false };
    }
    const running = await runDaemonSetupStep(
      ctx,
      {
        start: "Updating Ratel Local…",
        success: "Ratel Local is ready",
        failure: "We couldn't finish the update",
        help: "We couldn't finish updating Ratel Local.",
      },
      async () => {
        await actions.upgrade(status.port);
        const next = await actions.inspect();
        if (next.state !== "running" || next.version !== options.expectedVersion) {
          throw new Error(
            `daemon did not report version ${options.expectedVersion} after replacement`,
          );
        }
        return next;
      },
    );
    return { result: { ...running, changed: true }, ready: true };
  }

  if (status.state === "running") {
    ctx.prompts.note("Ratel Local is already running and ready to use.", "Ready");
    return { result: { ...status, changed: false }, ready: true };
  }

  if (status.state === "stopped") {
    const confirmed = options.yes
      ? true
      : await ctx.prompts.confirm({
          message: "Ratel Local isn't running. Start it now?",
          initialValue: true,
        });
    if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
      ctx.prompts.cancel("setup cancelled");
      return { result: { ...status, changed: false }, ready: false };
    }
    const running = await runDaemonSetupStep(
      ctx,
      {
        start: "Starting Ratel Local…",
        success: "Ratel Local is ready",
        failure: "Ratel Local couldn't start",
        help: "Ratel Local couldn't start.",
      },
      async () => {
        await actions.start();
        const next = await actions.inspect();
        if (
          next.state !== "running" ||
          (options.expectedVersion && next.version !== options.expectedVersion)
        ) {
          throw new Error("daemon did not report running after start");
        }
        return next;
      },
    );
    return { result: { ...running, changed: true }, ready: true };
  }

  const confirmed = options.yes
    ? true
    : await ctx.prompts.confirm({
        message:
          "Set up Ratel Local on this computer? It will start automatically when you sign in.",
        initialValue: true,
      });
  if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
    ctx.prompts.cancel("setup cancelled");
    return { result: { ...status, changed: false }, ready: false };
  }
  const running = await runDaemonSetupStep(
    ctx,
    {
      start: "Setting up Ratel Local…",
      success: "Ratel Local is ready",
      failure: "We couldn't finish setup",
      help: "We couldn't finish setting up Ratel Local.",
    },
    async () => {
      await actions.install();
      const next = await actions.inspect();
      if (
        next.state !== "running" ||
        (options.expectedVersion && next.version !== options.expectedVersion)
      ) {
        throw new Error("daemon did not report running after installation");
      }
      return next;
    },
  );
  return { result: { ...running, changed: true }, ready: true };
}

async function runDaemonSetupStep<T>(
  ctx: HandlerCtx,
  copy: { start: string; success: string; failure: string; help: string },
  action: () => Promise<T>,
): Promise<T> {
  const spinner = ctx.prompts.spinner();
  spinner.start(copy.start);
  try {
    const result = await action();
    spinner.stop(copy.success);
    return result;
  } catch (error) {
    spinner.stop(copy.failure);
    throw new Error(
      `${copy.help} Your projects and settings are safe. Run \`ratel-local daemon status\` to see what went wrong.`,
      { cause: error },
    );
  }
}

async function onboardAgents(
  ctx: HandlerCtx,
  options: SetupOptions,
): Promise<{ connected: SupportedAgentHostKind[]; cancelled: boolean }> {
  const detections = await (options.detectAgents ?? detectSupportedAgents)(ctx);
  ctx.prompts.note(renderAgentDetections(detections), "Supported agents");

  let selected: SupportedAgentHostKind[];
  if (options.agentsProvided) {
    selected =
      options.agentKinds === undefined
        ? detections.filter(({ present }) => present).map(({ kind }) => kind)
        : dedupeAgentKinds(options.agentKinds);
  } else if (options.yes) {
    ctx.prompts.note(
      "No agents were changed. Pass repeatable `--agent claude-code|codex` to connect agents during automated setup.",
      "Safe automation",
    );
    return { connected: [], cancelled: false };
  } else {
    const detected = detections.filter(({ present }) => present);
    if (detected.length === 0) {
      ctx.prompts.note(
        "No Claude Code or Codex configuration was detected. The daemon is ready; rerun setup after installing an agent.",
        "Agent connection",
      );
      return { connected: [], cancelled: false };
    }
    const picked = await ctx.prompts.multiselect<SupportedAgentHostKind>({
      message: "Which agents should connect through Ratel Local?",
      options: detected.map(({ kind, displayName, reasons }) => ({
        value: kind,
        label: displayName,
        hint: reasons[0],
      })),
      initialValues: detected.map(({ kind }) => kind),
      required: false,
    });
    if (ctx.prompts.isCancel(picked)) {
      ctx.prompts.cancel("agent onboarding cancelled · daemon remains ready");
      return { connected: [], cancelled: true };
    }
    selected = dedupeAgentKinds(picked as SupportedAgentHostKind[]);
  }

  const linkAgent =
    options.linkAgent ??
    ((targetCtx: HandlerCtx, agentKind: SupportedAgentHostKind) =>
      runLink(targetCtx, { agentKind, yes: true }).then(() => {}));
  for (const agentKind of selected) {
    await linkAgent(ctx, agentKind);
  }
  if (selected.length === 0) return { connected: [], cancelled: false };

  if (options.yes) {
    ctx.prompts.note(
      "Existing MCP servers and skills were not imported automatically. Use `ratel-local import --yes --agent <agent>` for an explicit automated migration.",
      "Safe automation",
    );
    return { connected: selected, cancelled: false };
  }

  const importSelection = await ctx.prompts.multiselect<SupportedAgentHostKind>({
    message: "Would you like to import existing tools and skills?",
    options: selected.map((kind) => ({
      value: kind,
      label: agentDisplayName(kind),
      hint: "You'll review everything before importing.",
    })),
    initialValues: [],
    required: false,
  });
  if (ctx.prompts.isCancel(importSelection)) {
    ctx.prompts.note("Skipped MCP and skill import.", "Import");
    return { connected: selected, cancelled: false };
  }

  const importAgent =
    options.importAgent ??
    ((targetCtx: HandlerCtx, agentKind: SupportedAgentHostKind) =>
      runImport(targetCtx, { agentKind }).then(() => {}));
  for (const agentKind of dedupeAgentKinds(importSelection as SupportedAgentHostKind[])) {
    await importAgent(ctx, agentKind);
  }
  return { connected: selected, cancelled: false };
}

async function detectSupportedAgents(ctx: HandlerCtx): Promise<SetupAgentDetection[]> {
  return Promise.all(
    SUPPORTED_AGENT_HOSTS.map(async ({ kind, displayName }) => {
      const detection = await new NamedAgentHostAdapter(kind).detect({
        env: ctx.env,
        fs: ctx.fs,
      });
      const pluginConnection = await findAgentHostRatelPluginConnection(ctx, kind);
      const pluginDetected = pluginConnection !== null;
      return {
        kind,
        displayName,
        present: detection.present || pluginDetected,
        reasons: [
          ...detection.reasons,
          ...(pluginDetected ? ["Found the Ratel Local agent plugin."] : []),
        ],
        warnings: detection.warnings,
      };
    }),
  );
}

function renderAgentDetections(detections: SetupAgentDetection[]): string {
  return detections
    .map(({ displayName, present, reasons, warnings }) => {
      const details = [...reasons, ...warnings].join(" ");
      return `- ${displayName}: ${present ? "detected" : "not detected"}${details ? ` · ${details}` : ""}`;
    })
    .join("\n");
}

function dedupeAgentKinds(agentKinds: readonly SupportedAgentHostKind[]): SupportedAgentHostKind[] {
  return [...new Set(agentKinds)];
}

function agentDisplayName(agentKind: SupportedAgentHostKind): string {
  return agentKind === "codex" ? "Codex" : "Claude Code";
}

async function runDaemonCommand(
  verb: "install" | "start" | "uninstall",
  ctx: HandlerCtx,
  options: SetupOptions,
  installPort?: number,
  log: (message: string) => void = ctx.log,
): Promise<void> {
  const flags: ParsedArgs["flags"] = {};
  if (verb === "install") {
    if (installPort !== undefined) flags.port = String(installPort);
    else if (ctx.argv.flags.port !== undefined) flags.port = ctx.argv.flags.port;
  }
  await runDaemon(
    {
      group: "daemon",
      verb,
      configPaths: [],
      rest: [],
      extras: [],
      flags,
    },
    ctx,
    options,
    log,
    {
      ...(options.serviceExecutable ??
        resolveSetupServiceExecutable({ expectedVersion: options.expectedVersion })),
      lifecycleProgress: false,
    },
  );
}

async function inspectForSetup(
  parsed: ParsedArgs,
  inspect: (parsed: ParsedArgs) => Promise<SetupDaemonStatus>,
): Promise<SetupDaemonStatus> {
  const { port, ...flagsWithoutPort } = parsed.flags;
  const existing = await inspect({ ...parsed, flags: flagsWithoutPort });
  if (existing.state !== "not-installed" || port === undefined) return existing;
  return inspect(parsed);
}

export function resolveSetupServiceExecutable(
  input: SetupServiceExecutableInput = {},
): SetupServiceExecutable {
  const env = input.env ?? process.env;
  const explicit = env.RATEL_LOCAL_BIN;
  if (explicit) {
    return {
      executablePath: input.execPath ?? process.execPath,
      executableArgs: [explicit],
    };
  }

  const isExecutable = input.isExecutable ?? defaultIsExecutable;
  const currentScript = input.argv1 ?? process.argv[1];
  if (currentScript && isReusableServiceScript(currentScript)) {
    return {
      executablePath: input.execPath ?? process.execPath,
      executableArgs: [currentScript],
    };
  }
  const npx = findOnPath("npx", env.PATH, isExecutable);
  if (npx && input.expectedVersion) {
    return {
      executablePath: input.execPath ?? process.execPath,
      executableArgs: [npx, "-y", `@ratel-ai/ratel-local@${input.expectedVersion}`],
    };
  }

  return { executablePath: currentScript ?? "ratel-local" };
}

function isReusableServiceScript(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.includes("/.npm/_npx/") || normalized.includes("/pnpm/dlx/")) return false;
  return /\.(?:c|m)?js$/.test(normalized) || normalized.endsWith("/ratel-local");
}

function findOnPath(
  command: string,
  pathValue: string | undefined,
  isExecutable: (path: string) => boolean,
): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
