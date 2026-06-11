import { join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  isRatelGatewayEntry,
  makeRatelGatewayEntry,
  type RatelGatewayEntry,
} from "../gateway-entry.js";
import type { HierarchyEnv } from "../hierarchy.js";
import { ProjectRootNotFoundError } from "../hierarchy.js";
import type { FileChange } from "../import-plan.js";
import type { JsonFs } from "../io.js";
import type { ServerEntry } from "../lib/index.js";
import type {
  AgentHostAdapter,
  AgentHostChangeSet,
  AgentHostContext,
  AgentHostDetection,
  AgentHostRemovedEntry,
  AgentHostState,
  AgentScope,
  AgentScopeState,
  GatewayLinkInput,
  RatelConfigPaths,
} from "./index.js";

// ADR 0003 records the smol-toml tradeoff and the future NAPI/WASM parser option.
export class CodexAgentHostAdapter implements AgentHostAdapter {
  async detect(ctx: AgentHostContext): Promise<AgentHostDetection> {
    const paths = [codexConfigPath("user", ctx.env)];
    if (ctx.env.projectRoot) paths.push(codexConfigPath("project", ctx.env));
    const present: string[] = [];
    for (const path of paths) {
      if ((await ctx.fs.read(path)) !== null) present.push(path);
    }
    return {
      displayName: "Codex",
      present: present.length > 0,
      reasons:
        present.length > 0
          ? present.map((path) => `Found ${path}.`)
          : ["No Codex config file found."],
      warnings: [],
    };
  }

  async read(ctx: AgentHostContext): Promise<AgentHostState> {
    const scopes: AgentScopeState[] = [];
    const userPath = codexConfigPath("user", ctx.env);
    scopes.push(await readCodexScope("user", "User", userPath, ctx.fs));
    if (ctx.env.projectRoot) {
      const projectPath = codexConfigPath("project", ctx.env);
      scopes.push(await readCodexScope("project", "Project", projectPath, ctx.fs));
    }
    return { host: { kind: "codex", displayName: "Codex" }, scopes };
  }

  async link(input: GatewayLinkInput): Promise<AgentHostChangeSet> {
    const changes: FileChange[] = [];
    const installedGatewayScopes: AgentScope[] = [];
    const removedNativeEntries: AgentHostRemovedEntry[] = [];
    const byScope = scopesByName(input.state);
    for (const scope of ["user", "project", "local"] as const) {
      const names = input.replacedEntriesByScope.get(scope);
      const state = byScope[scope];
      const configPaths = configChainForScope(scope, input.ratelConfigPaths);
      const shouldInstall = Boolean(names?.size || input.installGatewayScopes?.has(scope));
      if (!state || !shouldInstall || configPaths.length === 0) continue;
      const gateway = makeRatelGatewayEntry({ bin: input.bin, configPaths });
      const next = rewriteCodexConfig(state.rawText ?? "", names ?? new Set(), gateway);
      if (next !== state.rawText) {
        changes.push({
          kind: "write",
          path: state.path,
          before: state.rawText ?? null,
          after: next,
        });
      }
      installedGatewayScopes.push(scope);
      for (const name of names ?? []) removedNativeEntries.push({ scope, name });
    }
    return {
      changes,
      summary: {
        host: input.state.host,
        installedGatewayScopes,
        removedNativeEntries,
        warnings: [],
      },
    };
  }
}

function codexConfigPath(scope: AgentScope, env: HierarchyEnv): string {
  if (scope === "user") return join(env.homeDir, ".codex", "config.toml");
  if (!env.projectRoot)
    throw new ProjectRootNotFoundError(`scope "${scope}" requires a project root`);
  return join(env.projectRoot, ".codex", "config.toml");
}

async function readCodexScope(
  scope: AgentScope,
  displayName: string,
  path: string,
  fs: JsonFs,
): Promise<AgentScopeState> {
  const text = await fs.read(path);
  let mcpServers: Record<string, ServerEntry> = {};
  if (text !== null) {
    try {
      mcpServers = parseCodexMcpServers(text);
    } catch (err) {
      throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
    }
  }
  return {
    scope,
    displayName,
    path,
    available: text !== null,
    mcpServers,
    rawText: text ?? undefined,
  };
}

export function parseCodexMcpServers(text: string): Record<string, ServerEntry> {
  const out: Record<string, ServerEntry> = {};
  const root = parseToml(text);
  const servers = isPlainObject(root.mcp_servers)
    ? (root.mcp_servers as Record<string, unknown>)
    : {};
  for (const [name, values] of Object.entries(servers)) {
    const entry = parseCodexServerEntry(values);
    if (entry) out[name] = entry;
  }
  return out;
}

export function rewriteCodexConfig(
  text: string,
  remove: ReadonlySet<string>,
  gateway: RatelGatewayEntry,
): string {
  const sections = findTomlTableSections(text);
  const entries = parseCodexMcpServers(text);
  const removeNames = new Set(remove);
  for (const section of sections) {
    if (!isCodexServerRoot(section.path)) continue;
    const entry = entries[section.name];
    if (entry && isRatelGatewayEntry(section.name, entry)) removeNames.add(section.name);
  }
  const rootSectionNames = new Set(
    sections.filter((section) => isCodexServerRoot(section.path)).map((section) => section.name),
  );
  if ([...removeNames].some((name) => !rootSectionNames.has(name))) {
    return rewriteCodexConfigStructured(text, removeNames, gateway);
  }

  let out = "";
  let cursor = 0;
  for (const section of sections) {
    if (isCodexServerTableFor(section.path, removeNames)) {
      out += text.slice(cursor, section.start);
      cursor = section.end;
    }
  }
  out += text.slice(cursor);
  const trimmed = out.trimEnd();
  return `${trimmed}${trimmed.length > 0 ? "\n\n" : ""}${renderCodexServer(gateway.name, gateway.entry)}\n`;
}

function rewriteCodexConfigStructured(
  text: string,
  removeNames: ReadonlySet<string>,
  gateway: RatelGatewayEntry,
): string {
  const root = parseToml(text) as Record<string, unknown>;
  const servers = isPlainObject(root.mcp_servers)
    ? { ...(root.mcp_servers as Record<string, unknown>) }
    : {};
  for (const name of removeNames) delete servers[name];
  servers[gateway.name] = codexServerObject(gateway.entry);
  root.mcp_servers = servers;
  return stringifyToml(root);
}

interface TomlTableSection {
  path: string[];
  name: string;
  start: number;
  headerEnd: number;
  end: number;
}

function findTomlTableSections(text: string): TomlTableSection[] {
  const sections: TomlTableSection[] = [];
  const re = /^\s*\[([^\]\r\n]+)\]\s*$/gm;
  let match: RegExpExecArray | null;
  match = re.exec(text);
  while (match !== null) {
    const path = parseTomlDottedKey(match[1].trim());
    if (path.length > 0) {
      sections.push({
        path,
        name: path[1] ?? "",
        start: match.index,
        headerEnd: re.lastIndex,
        end: text.length,
      });
    }
    match = re.exec(text);
  }
  for (let i = 0; i < sections.length; i++) {
    sections[i].end = sections[i + 1]?.start ?? text.length;
  }
  return sections;
}

function parseCodexServerEntry(values: unknown): ServerEntry | null {
  if (!isPlainObject(values)) return null;
  if (typeof values.command === "string") {
    return {
      type: "stdio",
      command: values.command,
      args: asStringArray(values.args) ?? undefined,
      env: asStringRecord(values.env) ?? undefined,
      ...(typeof values.cwd === "string" ? { cwd: values.cwd } : {}),
    };
  }
  if (typeof values.url === "string") {
    const entry: ServerEntry = { type: "http", url: values.url };
    const headers = {
      ...(asStringRecord(values.http_headers) ?? asStringRecord(values.headers) ?? {}),
    };
    const codexEnvHeaders = asStringRecord(values.env_http_headers);
    if (codexEnvHeaders) {
      for (const [header, envName] of Object.entries(codexEnvHeaders)) {
        headers[header] = envPlaceholder(envName);
      }
    }
    if (typeof values.bearer_token_env_var === "string") {
      headers.Authorization = `Bearer ${envPlaceholder(values.bearer_token_env_var)}`;
    }
    if (Object.keys(headers).length > 0) entry.headers = headers;
    if (isPlainObject(values.oauth) && typeof values.oauth.client_id === "string") {
      entry.clientId = values.oauth.client_id;
    }
    const scopes = asStringArray(values.scopes);
    if (scopes && scopes.length > 0) entry.scope = scopes.join(" ");
    return entry;
  }
  return null;
}

function renderCodexServer(name: string, entry: ServerEntry): string {
  const lines = [`[mcp_servers.${name}]`];
  if (entry.type === "http" || entry.type === "sse") {
    lines.push(`url = ${JSON.stringify(entry.url ?? "")}`);
  } else {
    lines.push(`command = ${JSON.stringify(entry.command ?? "")}`);
    if (entry.args?.length) lines.push(`args = ${JSON.stringify(entry.args)}`);
  }
  lines.push("enabled = true");
  return lines.join("\n");
}

function codexServerObject(entry: ServerEntry): Record<string, unknown> {
  if (entry.type === "http" || entry.type === "sse") {
    return { url: entry.url ?? "", enabled: true };
  }
  const out: Record<string, unknown> = {
    command: entry.command ?? "",
    enabled: true,
  };
  if (entry.args?.length) out.args = entry.args;
  return out;
}

function parseTomlDottedKey(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === "\\" && i + 1 < input.length) {
        current += ch + input[++i];
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      parts.push(decodeTomlKeyPart(current.trim()));
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(decodeTomlKeyPart(current.trim()));
  return parts.filter((part) => part.length > 0);
}

function decodeTomlKeyPart(part: string): string {
  if (part.includes("\\")) return JSON.parse(`"${part}"`);
  return part;
}

function isCodexServerRoot(path: readonly string[]): path is readonly ["mcp_servers", string] {
  return path.length === 2 && path[0] === "mcp_servers";
}

function isCodexServerTableFor(path: readonly string[], names: ReadonlySet<string>): boolean {
  return path.length >= 2 && path[0] === "mcp_servers" && names.has(path[1]);
}

function scopesByName(state: AgentHostState): Partial<Record<AgentScope, AgentScopeState>> {
  return Object.fromEntries(state.scopes.map((scope) => [scope.scope, scope])) as Partial<
    Record<AgentScope, AgentScopeState>
  >;
}

function configChainForScope(scope: AgentScope, paths: RatelConfigPaths): string[] {
  if (scope === "user") return [paths.user];
  if (scope === "project" && paths.project) return [paths.user, paths.project];
  if (scope === "local" && paths.project && paths.local) {
    return [paths.user, paths.project, paths.local];
  }
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((item) => typeof item !== "string")) return null;
  return v;
}

function asStringRecord(v: unknown): Record<string, string> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== "string") return null;
    out[key] = value;
  }
  return out;
}

function envPlaceholder(name: string): string {
  return `\${${name}}`;
}
