import { execFile } from "node:child_process";
import { join } from "node:path";
import { readJson, writeJson } from "@ratel-ai/ratel-local-core";
import { type DaemonRequestScope, ensureDaemonToken } from "../../daemon/access.js";
import { InMemoryMcpClientRegistry } from "../../daemon/client-registry.js";
import { createMcpHttpRoute } from "../../daemon/mcp-http.js";
import { InMemoryScopedGatewayPool } from "../../daemon/scoped-gateway-pool.js";
import { openBrowser } from "../../ui/open-browser.js";
import { newSessionToken } from "../../ui/security.js";
import { startUiServer } from "../../ui/server.js";
import type { ParsedArgs } from "../args.js";
import { buildConfiguredGateway, type ServeOptions } from "./serve.js";
import type { HandlerCtx } from "./types.js";

export const DEFAULT_DAEMON_PORT = 5731;
export const DAEMON_LABEL = "ai.ratel.local.daemon";
export const SYSTEMD_SERVICE = "ratel-local-daemon.service";

export const DAEMON_USAGE = `usage: ratel-local daemon [verb] [args...]

Verbs:
  run        run the daemon in the foreground (default)
  install    install and start the login service
  uninstall  stop and remove the login service
  status     probe the configured daemon endpoint
  start      start the installed login service
  stop       stop the installed login service
  restart    restart the installed login service

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
  uptimeSeconds: number;
  upstreamCount: number;
  activeClientCount: number;
  activeGatewayCount: number;
  activeUserGatewayCount: number;
  activeProjectGatewayCount: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
type ProbeDaemon = (
  port: number,
) => Promise<{ ok: boolean; status?: DaemonStatusBody; error?: string }>;

interface DaemonHandlerDeps {
  open?: typeof openBrowser;
  commandRunner?: CommandRunner;
  executablePath?: string;
  getUid?: () => number;
  now?: () => Date;
  platform?: NodeJS.Platform;
  probe?: ProbeDaemon;
  ensureToken?: (homeDir: string) => Promise<string>;
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
    await installDaemon(parsed, ctx, log, opts);
    return {};
  }
  if (verb === "uninstall") {
    await uninstallDaemon(ctx, log, opts);
    return {};
  }
  if (verb === "status") {
    await reportDaemonStatus(parsed, ctx, log, opts);
    return {};
  }
  if (verb === "start") {
    await startDaemon(parsed, ctx, log, opts);
    return {};
  }
  if (verb === "stop") {
    await stopDaemon(ctx, log, opts);
    return {};
  }
  if (verb === "restart") {
    await stopDaemon(ctx, log, opts);
    await startDaemon(parsed, ctx, log, opts);
    return {};
  }
  throw new Error(`unknown daemon verb: ${verb}`);
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
  const startedAt = (opts.now ?? (() => new Date()))();
  const registry = new InMemoryMcpClientRegistry();
  const serverVersion = options.serverVersion ?? "0.0.0";
  const daemonToken = await (opts.ensureToken ?? ensureDaemonToken)(ctx.env.homeDir);
  const gatewayPool = new InMemoryScopedGatewayPool(async (scope) => {
    const scoped = scopeBuildInputs(parsed, ctx, options, scope);
    return (await buildConfiguredGateway(scoped.parsed, scoped.options, log)).gateway;
  }, log);
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
    publicRoute: async (req, res, path) => {
      if (req.method === "GET" && path === "/healthz") {
        writePlain(res, 200, "ok\n");
        return true;
      }
      if (req.method === "GET" && path === "/api/daemon/status") {
        const requestPort = (req.socket.localPort as number | undefined) ?? port;
        const poolStats = gatewayPool.stats();
        writeJsonResponse(res, 200, {
          ...stateForPort(requestPort),
          uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
          upstreamCount: poolStats.upstreamCount,
          activeClientCount: registry.listActiveClients().length,
          activeGatewayCount: poolStats.activeGatewayCount,
          activeUserGatewayCount: poolStats.activeUserGatewayCount,
          activeProjectGatewayCount: poolStats.activeProjectGatewayCount,
        });
        return true;
      }
      if (path !== "/mcp") return false;
      await mcp.handleRequest(req, res);
      return true;
    },
  });

  const state = stateForPort(ui.port);
  await writeDaemonState(ctx, state);

  log(`[ratel] daemon running at ${ui.url}`);
  log(`[ratel] daemon UI: ${state.uiUrl}`);
  log(`[ratel] MCP HTTP endpoint: ${state.mcpUrl}`);
  log("[ratel] ready for scoped MCP clients");
  log("[ratel] Press Ctrl-C to stop.");

  if (!noOpen) {
    (opts.open ?? openBrowser)(ui.url);
  }

  return {
    shutdown: async () => {
      await mcp.shutdown();
      await ui.shutdown();
      await gatewayPool.shutdown();
    },
  };
}

function scopeBuildInputs(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  options: ServeOptions,
  scope: DaemonRequestScope,
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
      ...(scope.kind === "user" ? { existsSync: () => false } : {}),
    },
  };
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
  homeDir: string;
  port: number;
}): string {
  const paths = daemonPaths(input.homeDir);
  const args = [
    input.executablePath,
    "daemon",
    "run",
    "--port",
    String(input.port),
    "--no-open",
    "--auto-config",
  ];
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
  <key>StandardOutPath</key>
  <string>${escapePlist(paths.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(paths.stderrLog)}</string>
</dict>
</plist>
`;
}

export function createSystemdUserService(input: {
  executablePath: string;
  homeDir: string;
  port: number;
}): string {
  const paths = daemonPaths(input.homeDir);
  return `[Unit]
Description=Ratel Local daemon
After=network.target

[Service]
Type=simple
ExecStart=${systemdQuote(input.executablePath)} daemon run --port ${input.port} --no-open --auto-config
WorkingDirectory=${systemdQuote(input.homeDir)}
Restart=always
RestartSec=2
StandardOutput=append:${systemdPath(paths.stdoutLog)}
StandardError=append:${systemdPath(paths.stderrLog)}

[Install]
WantedBy=default.target
`;
}

async function installDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await installLinuxDaemon(parsed, ctx, log, opts);
    return;
  }
  ensureMacos("daemon install", opts);
  const port = parseDaemonPort(parsed.flags.port);
  const paths = daemonPaths(ctx.env.homeDir);
  await ctx.fs.mkdirp(paths.logsDir);
  await ctx.fs.mkdirp(paths.launchAgentsDir);
  await ctx.fs.writeAtomic(
    paths.plist,
    createLaunchAgentPlist({
      executablePath: opts.executablePath ?? process.argv[1] ?? "ratel-local",
      homeDir: ctx.env.homeDir,
      port,
    }),
  );
  await bootstrapDaemon(ctx, opts);
  await kickstartDaemon(ctx, opts);
  await waitForDaemon(port, opts.probe ?? probeDaemon);
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
  log(`[ratel] daemon uninstalled: ${paths.plist}`);
}

async function startDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const platform = daemonPlatform(opts);
  if (platform === "linux") {
    await startLinuxDaemon(parsed, ctx, log, opts);
    return;
  }
  ensureMacos("daemon start", opts);
  const paths = daemonPaths(ctx.env.homeDir);
  if (!(await ctx.fs.exists(paths.plist))) {
    throw new Error(`daemon is not installed; run "ratel-local daemon install" first`);
  }
  await bootstrapDaemon(ctx, opts, { ignoreFailure: true });
  await kickstartDaemon(ctx, opts);
  const port = await daemonPort(parsed, ctx);
  await waitForDaemon(port, opts.probe ?? probeDaemon);
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
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const port = parseDaemonPort(parsed.flags.port);
  const paths = daemonPaths(ctx.env.homeDir);
  await ctx.fs.mkdirp(paths.logsDir);
  await ctx.fs.mkdirp(paths.systemdUserDir);
  await ctx.fs.writeAtomic(
    paths.systemdService,
    createSystemdUserService({
      executablePath: opts.executablePath ?? process.argv[1] ?? "ratel-local",
      homeDir: ctx.env.homeDir,
      port,
    }),
  );
  await systemctl(opts, ["daemon-reload"]);
  await systemctl(opts, ["enable", "--now", SYSTEMD_SERVICE]);
  await waitForDaemon(port, opts.probe ?? probeDaemon);
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
  await systemctl(opts, ["daemon-reload"], { ignoreFailure: true });
  log(`[ratel] daemon uninstalled: ${paths.systemdService}`);
}

async function startLinuxDaemon(
  parsed: ParsedArgs,
  ctx: HandlerCtx,
  log: (m: string) => void,
  opts: DaemonHandlerDeps,
): Promise<void> {
  const paths = daemonPaths(ctx.env.homeDir);
  if (!(await ctx.fs.exists(paths.systemdService))) {
    throw new Error(`daemon is not installed; run "ratel-local daemon install" first`);
  }
  await systemctl(opts, ["start", SYSTEMD_SERVICE]);
  const port = await daemonPort(parsed, ctx);
  await waitForDaemon(port, opts.probe ?? probeDaemon);
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

async function waitForDaemon(port: number, probe: ProbeDaemon): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError = "not responding";
  while (Date.now() < deadline) {
    const result = await probe(port);
    if (result.ok) return;
    lastError = result.error ?? lastError;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `daemon did not become healthy at http://127.0.0.1:${port}/healthz: ${lastError}`,
  );
}

async function probeDaemon(
  port: number,
): Promise<{ ok: boolean; status?: DaemonStatusBody; error?: string }> {
  const statusUrl = `http://127.0.0.1:${port}/api/daemon/status`;
  const healthUrl = `http://127.0.0.1:${port}/healthz`;
  try {
    const statusRes = await fetchWithTimeout(statusUrl);
    if (statusRes.ok) {
      return { ok: true, status: (await statusRes.json()) as DaemonStatusBody };
    }
    const healthRes = await fetchWithTimeout(healthUrl);
    return healthRes.ok ? { ok: true } : { ok: false, error: `HTTP ${healthRes.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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

function configMode(parsed: ParsedArgs): DaemonState["configMode"] {
  if (parsed.flags["auto-config"] === true) return "auto";
  if (parsed.configPaths.length > 0) return "explicit";
  return "default";
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
