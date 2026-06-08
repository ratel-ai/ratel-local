import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportFactory } from "../lib/index.js";
import { ArgError, type ParsedArgs, parseArgs } from "./args.js";
import type { BackupFs } from "./backup.js";
import { BACKUP_USAGE, runBackup } from "./handlers/backup.js";
import { MCP_USAGE, runMcp } from "./handlers/mcp.js";
import { runServe } from "./handlers/serve.js";
import type { HandlerCtx } from "./handlers/types.js";
import { runUi } from "./handlers/ui.js";
import { findProjectRoot, type HierarchyEnv } from "./hierarchy.js";
import { type JsonFs, nodeFs } from "./io.js";
import { type PromptAdapter, silentPromptAdapter } from "./prompts.js";

export interface RunCliOptions {
  readConfig?: (path: string) => Promise<unknown>;
  transportFactory?: TransportFactory;
  serverTransport?: Transport;
  logger?: (message: string) => void;
  serverName?: string;
  serverVersion?: string;
  prompts?: PromptAdapter;
  fs?: JsonFs & BackupFs;
  env?: HierarchyEnv;
  now?: () => Date;
  cliVersion?: string;
}

export interface RunCliResult {
  shutdown?: () => Promise<void>;
}

const TOP_USAGE = `usage: ratel-mcp <command> [args...]

Commands:
  serve    start the gateway over stdio (use --config <path>; repeat for multi-file merge)
  mcp      manage MCP servers (add, remove, list, get, edit, import, link, auth)
  backup   manage backup snapshots (list, undo)
  ui       launch a local browser UI mirroring the CLI [--port N] [--no-open]

Run \`ratel-mcp <group>\` for the verbs available in a group.`;

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const log = options.logger ?? ((m) => console.error(m));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      log(`${err.message}\n${TOP_USAGE}`);
    }
    throw err;
  }

  if (parsed.group === "help") {
    log(TOP_USAGE);
    return {};
  }

  if (parsed.group === "version") {
    log(options.cliVersion ?? options.serverVersion ?? "0.0.0");
    return {};
  }

  if (parsed.group === "mcp" && parsed.verb === undefined) {
    log(MCP_USAGE);
    return {};
  }

  if (parsed.group === "backup" && parsed.verb === undefined) {
    log(BACKUP_USAGE);
    return {};
  }

  if (parsed.group === "serve") {
    return runServe(parsed, options, log);
  }

  const ctx: HandlerCtx = {
    argv: parsed,
    env: options.env ?? defaultEnv(),
    fs: options.fs ?? nodeFs,
    log,
    prompts: options.prompts ?? silentPromptAdapter(),
  };

  if (parsed.group === "ui") {
    return runUi(parsed, ctx, log);
  }

  if (parsed.group === "mcp") {
    await runMcp(ctx);
    return {};
  }

  if (parsed.group === "backup") {
    await runBackup(ctx);
    return {};
  }

  throw new ArgError(`unhandled command: ${parsed.group} ${parsed.verb}`);
}

function defaultEnv(): HierarchyEnv {
  const env: HierarchyEnv = { homeDir: homedir() };
  try {
    env.projectRoot = findProjectRoot(process.cwd(), { existsSync });
  } catch {
    // no project root; project/local scopes will surface a clear error when used
  }
  return env;
}
