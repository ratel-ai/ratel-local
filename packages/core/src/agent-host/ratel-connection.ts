import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { isRatelGatewayEntry } from "../gateway-entry.js";
import type { FileChange } from "../import-plan.js";
import { isPlainObject } from "../json.js";
import { rewriteCodexPluginMcpServerEnabled } from "./codex.js";
import {
  type AgentHostContext,
  type AgentHostState,
  type AgentScope,
  NamedAgentHostAdapter,
  SUPPORTED_AGENT_HOSTS,
  type SupportedAgentHostKind,
} from "./index.js";

export type RatelConnectionKind = "none" | "explicit" | "plugin" | "duplicate";

export interface RatelConnectionState {
  kind: RatelConnectionKind;
  linked: boolean;
  explicit: boolean;
  plugin: boolean;
  pluginDisabled?: boolean;
}

export async function getAgentHostRatelConnection(
  kind: SupportedAgentHostKind,
  state: AgentHostState | null,
  ctx: AgentHostContext,
  warnings: string[] = [],
): Promise<RatelConnectionState> {
  const explicit =
    state?.scopes.some((scope) =>
      Object.entries(scope.mcpServers).some(([name, entry]) => isRatelGatewayEntry(name, entry)),
    ) ?? false;
  const pluginState =
    kind === "claude-code"
      ? await detectClaudeRatelPlugin(ctx, warnings)
      : detectCodexRatelPlugin(state, warnings);
  const plugin = pluginState.enabled;
  const connectionKind: RatelConnectionKind = explicit
    ? plugin
      ? "duplicate"
      : "explicit"
    : plugin
      ? "plugin"
      : "none";
  return {
    kind: connectionKind,
    linked: explicit || plugin,
    explicit,
    plugin,
    ...(pluginState.disabled ? { pluginDisabled: true } : {}),
  };
}

interface PluginState {
  enabled: boolean;
  disabled: boolean;
}

function detectCodexRatelPlugin(state: AgentHostState | null, warnings: string[]): PluginState {
  const user = state?.scopes.find((scope) => scope.scope === "user");
  if (!user?.rawText) return { enabled: false, disabled: false };
  try {
    const root = parseToml(user.rawText);
    if (!isPlainObject(root.plugins)) return { enabled: false, disabled: false };
    const plugin = root.plugins["ratel-local@ratel"];
    if (!isPlainObject(plugin) || plugin.enabled !== true) {
      return { enabled: false, disabled: false };
    }
    const servers = isPlainObject(plugin.mcp_servers) ? plugin.mcp_servers : null;
    const server = servers?.["ratel-local"];
    const disabled = isPlainObject(server) && server.enabled === false;
    return { enabled: !disabled, disabled };
  } catch (err) {
    warnings.push(`Failed to read Codex plugin settings: ${(err as Error).message}`);
    return { enabled: false, disabled: false };
  }
}

export function buildAgentHostRatelPluginLinkChanges(
  kind: SupportedAgentHostKind,
  state: AgentHostState,
  connection: RatelConnectionState,
): FileChange[] {
  if (kind !== "codex" || connection.linked || !connection.pluginDisabled) return [];
  const user = state.scopes.find((scope) => scope.scope === "user");
  if (!user?.rawText) return [];
  const after = rewriteCodexPluginMcpServerEnabled(
    user.rawText,
    "ratel-local@ratel",
    "ratel-local",
  );
  if (after === user.rawText) return [];
  return [{ kind: "write", path: user.path, before: user.rawText, after }];
}

export async function findAgentHostRatelPluginConnection(
  ctx: AgentHostContext,
  requestedKind?: SupportedAgentHostKind,
): Promise<{ state: AgentHostState; connection: RatelConnectionState } | null> {
  const kinds = requestedKind ? [requestedKind] : SUPPORTED_AGENT_HOSTS.map(({ kind }) => kind);
  for (const kind of kinds) {
    try {
      const state = await new NamedAgentHostAdapter(kind).read(ctx);
      const connection = await getAgentHostRatelConnection(kind, state, ctx);
      if (connection.plugin) return { state, connection };
    } catch {
      // Normal detection reports readable host-config failures before this fallback is reached.
    }
  }
  return null;
}

export function pluginLinkNoOpMessage(
  displayName: string,
  connection: RatelConnectionState,
): string {
  if (connection.kind === "duplicate") {
    return `${displayName} has duplicate Ratel connections through the Ratel Local plugin and explicit MCP configuration. Link will not change either connection.`;
  }
  return `${displayName} is already linked through the Ratel Local plugin; no explicit gateway is needed.`;
}

async function detectClaudeRatelPlugin(
  ctx: AgentHostContext,
  warnings: string[],
): Promise<PluginState> {
  let enabled = false;
  for (const { scope, path } of claudeSettingsPaths(ctx.env)) {
    const settings = await readSettingsLenient(ctx, path, warnings, scope);
    const decision = settings ? ratelPluginDecision(settings) : undefined;
    if (decision === "disabled") enabled = false;
    if (decision === "enabled") enabled = true;
  }
  return { enabled, disabled: false };
}

function ratelPluginDecision(
  settings: Record<string, unknown>,
): "enabled" | "disabled" | undefined {
  if (pluginListHasRatel(settings.disabledPlugins)) return "disabled";
  const enabled = settings.enabledPlugins;
  if (Array.isArray(enabled)) return pluginListHasRatel(enabled) ? "enabled" : undefined;
  if (isPlainObject(enabled)) {
    let decision: "enabled" | "disabled" | undefined;
    for (const [name, value] of Object.entries(enabled)) {
      if (!isRatelPluginName(name)) continue;
      decision = value === false ? "disabled" : "enabled";
    }
    return decision;
  }
  return undefined;
}

function pluginListHasRatel(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === "string" && isRatelPluginName(item))
  );
}

function isRatelPluginName(value: string): boolean {
  return value === "ratel-local" || value.startsWith("ratel-local@");
}

function claudeSettingsPaths(
  env: AgentHostContext["env"],
): Array<{ scope: AgentScope; path: string }> {
  const paths: Array<{ scope: AgentScope; path: string }> = [
    { scope: "user", path: join(env.homeDir, ".claude", "settings.json") },
  ];
  if (env.projectRoot) {
    paths.push(
      { scope: "project", path: join(env.projectRoot, ".claude", "settings.json") },
      { scope: "local", path: join(env.projectRoot, ".claude", "settings.local.json") },
    );
  }
  return paths;
}

async function readSettingsLenient(
  ctx: AgentHostContext,
  path: string,
  warnings: string[],
  scope: AgentScope,
): Promise<Record<string, unknown> | null> {
  try {
    const text = await ctx.fs.read(path);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error(`${path}: root must be a JSON object`);
    return parsed;
  } catch (err) {
    warnings.push(`Failed to read ${scope} settings: ${(err as Error).message}`);
    return null;
  }
}
