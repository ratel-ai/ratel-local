import { basename } from "node:path";
import type { AgentScope, SupportedAgentHostKind } from "./agent-host/index.js";
import type { ServerEntry } from "./lib/index.js";
import type { ResolvedBin } from "./locate-bin.js";

const GATEWAY_ENTRY_NAMES = new Set(["ratel", "ratel-mcp", "ratel-local"]);
const DEFAULT_GATEWAY_ENTRY_NAME = "ratel-local";

export interface RatelGatewayEntry {
  name: typeof DEFAULT_GATEWAY_ENTRY_NAME;
  entry: ServerEntry;
}

export function makeRatelGatewayEntry(input: {
  bin: ResolvedBin;
  agentHost: SupportedAgentHostKind;
  linkScope: AgentScope;
  projectRoot?: string;
}): RatelGatewayEntry {
  const args = [
    ...input.bin.args,
    "connect",
    "--agent-host",
    input.agentHost,
    "--link-scope",
    input.linkScope,
  ];
  if (input.linkScope !== "user" && input.projectRoot) {
    args.push("--project-root", input.projectRoot);
  }
  return {
    name: DEFAULT_GATEWAY_ENTRY_NAME,
    entry: {
      type: "stdio",
      command: input.bin.command,
      args,
    },
  };
}

export function isRatelGatewayEntry(name: string, entry: ServerEntry): boolean {
  if (!GATEWAY_ENTRY_NAMES.has(name) || entry.type !== "stdio" || !entry.command) return false;
  const cliArgs = ratelCliArgs(entry.command, entry.args ?? []);
  if (!cliArgs) return false;
  if (cliArgs.length === 0 && (name === "ratel-local" || name === "ratel-mcp")) return true;
  return isConnectorArgs(cliArgs) || isLegacyServeArgs(cliArgs);
}

function ratelCliArgs(command: string, args: readonly string[]): readonly string[] | null {
  const executable = basename(command).toLowerCase();
  if (executable === "ratel-local" || executable === "ratel-mcp") return args;
  if (/(?:^|[/\\])ratel-(?:local|mcp)[/\\]dist[/\\]bin\.js$/.test(command)) return args;
  if (executable === "node" || executable === "node.exe") {
    const [script, ...rest] = args;
    if (script && /(?:^|[/\\])ratel-(?:local|mcp)[/\\]dist[/\\]bin\.js$/.test(script)) {
      return rest;
    }
  }
  if (executable === "npx" || executable === "npx.cmd") {
    let packageIndex = 0;
    while (args[packageIndex] === "-y" || args[packageIndex] === "--yes") packageIndex++;
    const packageName = args[packageIndex];
    if (/^@ratel-ai\/ratel-(?:local|mcp)(?:@[^\s]+)?$/.test(packageName ?? "")) {
      return args.slice(packageIndex + 1);
    }
  }
  return null;
}

function isLegacyServeArgs(args: readonly string[]): boolean {
  if (args[0] !== "serve" || args.length < 3 || (args.length - 1) % 2 !== 0) return false;
  for (let i = 1; i < args.length; i += 2) {
    if (args[i] !== "--config" || !isFlagValue(args[i + 1])) return false;
  }
  return true;
}

function isConnectorArgs(args: readonly string[]): boolean {
  if (args[0] !== "connect") return false;
  let agentHost: string | undefined;
  let linkScope: string | undefined;
  let projectRoot: string | undefined;
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!isFlagValue(value)) return false;
    if (flag === "--agent-host" && agentHost === undefined) agentHost = value;
    else if (flag === "--link-scope" && linkScope === undefined) linkScope = value;
    else if (flag === "--project-root" && projectRoot === undefined) projectRoot = value;
    else return false;
  }
  const metadataValid =
    (agentHost === "claude-code" || agentHost === "codex") &&
    (linkScope === "user" || linkScope === "project" || linkScope === "local");
  return metadataValid && (linkScope === "user" ? projectRoot === undefined : !!projectRoot);
}

function isFlagValue(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("--");
}
