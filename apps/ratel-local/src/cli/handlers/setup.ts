import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ParsedArgs } from "../args.js";
import { inspectDaemonService, runDaemon } from "./daemon.js";
import type { ServeOptions } from "./serve.js";
import type { HandlerCtx } from "./types.js";

export const SETUP_USAGE = `usage: ratel-local setup [options]

Install or start the persistent Ratel daemon for plugin connectors.

Options:
  --yes       accept the install/start action without prompting
  --port N    choose the daemon port for first installation (default: 5731)
  --help      show this help`;

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
  expectedVersion?: string;
  inspect?: (parsed: ParsedArgs) => Promise<SetupDaemonStatus>;
  install?: () => Promise<void>;
  start?: () => Promise<void>;
  upgrade?: (port: number) => Promise<void>;
  serviceExecutable?: SetupServiceExecutable;
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
  ctx.prompts.intro("Ratel · persistent daemon setup");
  ctx.prompts.note(
    "One login service hosts Ratel for every agent session. Each connector sends its project root, so user, project, and local MCP configs remain isolated.",
    "How it works",
  );

  const inspectService = options.inspect ?? ((parsed) => inspectDaemonService(parsed, ctx));
  const inspect = () => inspectForSetup(ctx.argv, inspectService);
  const install = options.install ?? (() => runDaemonCommand("install", ctx, options));
  const start = options.start ?? (() => runDaemonCommand("start", ctx, options));
  const upgrade =
    options.upgrade ??
    (async (port: number) => {
      await runDaemonCommand("uninstall", ctx, options);
      await runDaemonCommand("install", ctx, options, port);
    });
  const status = await inspect();

  if (
    status.state !== "not-installed" &&
    options.expectedVersion &&
    status.version !== options.expectedVersion
  ) {
    const currentVersion = status.version ?? "unknown";
    const confirmed = options.yes
      ? true
      : await ctx.prompts.confirm({
          message: `Replace daemon version ${currentVersion} with ${options.expectedVersion}?`,
          initialValue: true,
        });
    if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
      ctx.prompts.cancel("setup cancelled");
      return { ...status, changed: false };
    }
    await upgrade(status.port);
    const running = await inspect();
    if (running.state !== "running" || running.version !== options.expectedVersion) {
      throw new Error(`daemon did not report version ${options.expectedVersion} after replacement`);
    }
    ctx.prompts.outro(`setup complete · daemon updated to ${options.expectedVersion}`);
    return { ...running, changed: true };
  }

  if (status.state === "running") {
    ctx.prompts.note(
      `The Ratel daemon is already running at http://127.0.0.1:${status.port}.`,
      "Daemon",
    );
    ctx.prompts.outro("setup complete");
    return { ...status, changed: false };
  }

  if (status.state === "stopped") {
    const confirmed = options.yes
      ? true
      : await ctx.prompts.confirm({
          message: "Start the installed Ratel daemon now?",
          initialValue: true,
        });
    if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
      ctx.prompts.cancel("setup cancelled");
      return { ...status, changed: false };
    }
    await start();
    const running = await inspect();
    if (
      running.state !== "running" ||
      (options.expectedVersion && running.version !== options.expectedVersion)
    ) {
      throw new Error("daemon did not report running after start");
    }
    ctx.prompts.outro("setup complete · daemon running");
    return { ...running, changed: true };
  }

  const confirmed = options.yes
    ? true
    : await ctx.prompts.confirm({
        message: `Install the Ratel daemon as a login service on port ${status.port}?`,
        initialValue: true,
      });
  if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
    ctx.prompts.cancel("setup cancelled");
    return { ...status, changed: false };
  }
  await install();
  const running = await inspect();
  if (
    running.state !== "running" ||
    (options.expectedVersion && running.version !== options.expectedVersion)
  ) {
    throw new Error("daemon did not report running after installation");
  }
  ctx.prompts.outro("setup complete · daemon installed and running");
  return { ...running, changed: true };
}

async function runDaemonCommand(
  verb: "install" | "start" | "uninstall",
  ctx: HandlerCtx,
  options: SetupOptions,
  installPort?: number,
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
    ctx.log,
    options.serviceExecutable ??
      resolveSetupServiceExecutable({ expectedVersion: options.expectedVersion }),
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
  if (explicit) return { executablePath: explicit };

  const isExecutable = input.isExecutable ?? defaultIsExecutable;
  const npx = findOnPath("npx", env.PATH, isExecutable);
  if (npx && input.expectedVersion) {
    return {
      executablePath: input.execPath ?? process.execPath,
      executableArgs: [npx, "-y", `@ratel-ai/ratel-local@${input.expectedVersion}`],
    };
  }

  return { executablePath: input.argv1 ?? process.argv[1] ?? "ratel-local" };
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
