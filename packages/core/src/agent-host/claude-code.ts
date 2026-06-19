import { join, resolve } from "node:path";
import {
  isRatelGatewayEntry,
  makeRatelGatewayEntry,
  type RatelGatewayEntry,
} from "../gateway-entry.js";
import type { HierarchyEnv } from "../hierarchy.js";
import { ProjectRootNotFoundError } from "../hierarchy.js";
import type { FileChange } from "../import-plan.js";
import { isPlainObject } from "../json.js";
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

interface ClaudeConfigDoc {
  scope: AgentScope;
  path: string;
  raw: Record<string, unknown>;
  mcpServers: Record<string, ServerEntry>;
}

export class ClaudeCodeAgentHostAdapter implements AgentHostAdapter {
  async detect(ctx: AgentHostContext): Promise<AgentHostDetection> {
    const paths = [
      claudeConfigPath("user", ctx.env),
      ...(ctx.env.projectRoot ? [claudeConfigPath("project", ctx.env)] : []),
    ];
    const present: string[] = [];
    for (const path of paths) {
      if ((await ctx.fs.read(path)) !== null) present.push(path);
    }
    return {
      displayName: "Claude Code",
      present: present.length > 0,
      reasons:
        present.length > 0
          ? present.map((path) => `Found ${path}.`)
          : ["No Claude Code config file found."],
      warnings: [],
    };
  }

  async read(ctx: AgentHostContext): Promise<AgentHostState> {
    const scopes: AgentScopeState[] = [];
    const user = await readClaudeConfig("user", ctx.env, ctx.fs);
    scopes.push(toScopeState("user", "User", claudeConfigPath("user", ctx.env), user));
    if (ctx.env.projectRoot) {
      const project = await readClaudeConfig("project", ctx.env, ctx.fs);
      const local = await readClaudeConfig("local", ctx.env, ctx.fs);
      scopes.push(
        toScopeState("project", "Project", claudeConfigPath("project", ctx.env), project),
      );
      scopes.push(toScopeState("local", "Local", claudeConfigPath("local", ctx.env), local));
    }
    return { host: { kind: "claude-code", displayName: "Claude Code" }, scopes };
  }

  async link(input: GatewayLinkInput): Promise<AgentHostChangeSet> {
    const changes: FileChange[] = [];
    const installedGatewayScopes: AgentScope[] = [];
    const removedNativeEntries: AgentHostRemovedEntry[] = [];
    const byScope = scopesByName(input.state);
    const user = byScope.user;
    const project = byScope.project;
    const local = byScope.local;
    const userRemove = input.replacedEntriesByScope.get("user");
    const projectRemove = input.replacedEntriesByScope.get("project");
    const localRemove = input.replacedEntriesByScope.get("local");
    const userInstall = Boolean(userRemove?.size || input.installGatewayScopes?.has("user"));
    const projectInstall = Boolean(
      projectRemove?.size || input.installGatewayScopes?.has("project"),
    );
    const localInstall = Boolean(localRemove?.size || input.installGatewayScopes?.has("local"));
    const userGateway = userInstall
      ? makeRatelGatewayEntry({ bin: input.bin, configPaths: [input.ratelConfigPaths.user] })
      : undefined;
    const projectGateway =
      projectInstall && input.ratelConfigPaths.project
        ? makeRatelGatewayEntry({
            bin: input.bin,
            configPaths: [input.ratelConfigPaths.user, input.ratelConfigPaths.project],
          })
        : undefined;
    const localGateway =
      localInstall && input.ratelConfigPaths.project && input.ratelConfigPaths.local
        ? makeRatelGatewayEntry({
            bin: input.bin,
            configPaths: [
              input.ratelConfigPaths.user,
              input.ratelConfigPaths.project,
              input.ratelConfigPaths.local,
            ],
          })
        : undefined;

    const home = user ?? local;
    if (home?.raw && (userInstall || localInstall)) {
      const next = rewriteHomeClaude(
        home.raw,
        userGateway,
        localGateway,
        userInstall ? (userRemove ?? new Set()) : null,
        localInstall ? (localRemove ?? new Set()) : null,
        deriveProjectRoot(input.ratelConfigPaths),
      );
      pushJsonWrite(changes, home.path, home.raw, next);
    }
    if (project?.raw && projectInstall && projectGateway) {
      const next = rewriteProjectClaude(project.raw, projectGateway, projectRemove ?? new Set());
      pushJsonWrite(changes, project.path, project.raw, next);
    }

    for (const [scope, names] of input.replacedEntriesByScope) {
      if (names.size === 0) continue;
      installedGatewayScopes.push(scope);
      for (const name of names) removedNativeEntries.push({ scope, name });
    }
    for (const scope of input.installGatewayScopes ?? []) {
      if (!installedGatewayScopes.includes(scope)) installedGatewayScopes.push(scope);
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

function claudeConfigPath(scope: AgentScope, env: HierarchyEnv): string {
  if (scope === "user" || scope === "local") return join(env.homeDir, ".claude.json");
  if (!env.projectRoot)
    throw new ProjectRootNotFoundError(`scope "project" requires a project root`);
  return join(env.projectRoot, ".mcp.json");
}

async function readClaudeConfig(
  scope: AgentScope,
  env: HierarchyEnv,
  fs: AgentHostContext["fs"],
): Promise<ClaudeConfigDoc | null> {
  if (scope === "local" && !env.projectRoot) {
    throw new ProjectRootNotFoundError(`scope "local" requires a project root`);
  }
  const path = claudeConfigPath(scope, env);
  const text = await fs.read(path);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(raw)) throw new Error(`${path}: root must be a JSON object`);
  return { scope, path, raw, mcpServers: readClaudeMcpServers(scope, raw, env) };
}

function toScopeState(
  scope: AgentScope,
  displayName: string,
  path: string,
  doc: ClaudeConfigDoc | null,
): AgentScopeState {
  return {
    scope,
    displayName,
    path,
    available: doc !== null,
    mcpServers: doc?.mcpServers ?? {},
    raw: doc?.raw,
  };
}

function readClaudeMcpServers(
  scope: AgentScope,
  raw: Record<string, unknown>,
  env: HierarchyEnv,
): Record<string, ServerEntry> {
  if (scope === "local") {
    const projects = raw.projects;
    if (!isPlainObject(projects)) return {};
    const root = resolve(env.projectRoot as string);
    const entry = projects[root];
    if (!isPlainObject(entry)) return {};
    return asServerEntries(entry.mcpServers);
  }
  return asServerEntries(raw.mcpServers);
}

function rewriteHomeClaude(
  raw: Record<string, unknown>,
  userRatelEntry: RatelGatewayEntry | undefined,
  localRatelEntry: RatelGatewayEntry | undefined,
  removeUser: ReadonlySet<string> | null,
  removeLocal: ReadonlySet<string> | null,
  projectRoot: string | undefined,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  if (removeUser && userRatelEntry) {
    const before = isPlainObject(out.mcpServers) ? (out.mcpServers as Record<string, unknown>) : {};
    out.mcpServers = mergeWithRatel(before, removeUser, userRatelEntry);
  }
  if (removeLocal && localRatelEntry && projectRoot) {
    const absRoot = resolve(projectRoot);
    const projects = isPlainObject(out.projects) ? (out.projects as Record<string, unknown>) : {};
    const entry = isPlainObject(projects[absRoot])
      ? { ...(projects[absRoot] as Record<string, unknown>) }
      : {};
    const before = isPlainObject(entry.mcpServers)
      ? (entry.mcpServers as Record<string, unknown>)
      : {};
    entry.mcpServers = mergeWithRatel(before, removeLocal, localRatelEntry);
    projects[absRoot] = entry;
    out.projects = projects;
  }
  return out;
}

function rewriteProjectClaude(
  raw: Record<string, unknown>,
  ratelEntry: RatelGatewayEntry,
  remove: ReadonlySet<string>,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const before = isPlainObject(out.mcpServers) ? (out.mcpServers as Record<string, unknown>) : {};
  out.mcpServers = mergeWithRatel(before, remove, ratelEntry);
  return out;
}

function mergeWithRatel(
  before: Record<string, unknown>,
  remove: ReadonlySet<string>,
  ratelEntry: RatelGatewayEntry,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(before)) {
    if (isServerEntry(entry) && isRatelGatewayEntry(name, entry)) continue;
    if (remove.has(name)) continue;
    next[name] = entry;
  }
  next[ratelEntry.name] = ratelEntry.entry;
  return next;
}

function deriveProjectRoot(paths: RatelConfigPaths): string | undefined {
  if (paths.project) return paths.project.replace(/\/\.ratel\/config\.json$/, "");
  if (paths.local) return paths.local.replace(/\/\.ratel\/config\.local\.json$/, "");
  return undefined;
}

function asServerEntries(v: unknown): Record<string, ServerEntry> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, ServerEntry> = {};
  for (const [k, ent] of Object.entries(v)) {
    if (isPlainObject(ent)) out[k] = ent as unknown as ServerEntry;
  }
  return out;
}

function pushJsonWrite(
  changes: FileChange[],
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const beforeText = serializeJson(before);
  const afterText = serializeJson(after);
  if (beforeText !== afterText)
    changes.push({ kind: "write", path, before: beforeText, after: afterText });
}

function scopesByName(state: AgentHostState): Partial<Record<AgentScope, AgentScopeState>> {
  return Object.fromEntries(state.scopes.map((scope) => [scope.scope, scope])) as Partial<
    Record<AgentScope, AgentScopeState>
  >;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isServerEntry(v: unknown): v is ServerEntry {
  return isPlainObject(v);
}
