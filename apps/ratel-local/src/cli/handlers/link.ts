import { join } from "node:path";
import type { BackupManifest, RatelConfig, RatelConfigDocument } from "@ratel-ai/ratel-local-core";
import {
  type AgentImportDraft,
  AutomaticAgentHostAdapter,
  buildAgentHostRatelPluginLinkChanges,
  buildAgentLinkPlan,
  documentRevision,
  findAgentHostRatelPluginConnection,
  getAgentHostRatelConnection,
  MISSING_DOCUMENT_REVISION,
  MutationConflictError,
  NamedAgentHostAdapter,
  parseConfig,
  pluginLinkNoOpMessage,
  type ResolvedBin,
  ratelConfigPath,
  readJson,
  type SupportedAgentHostKind,
  startBackup,
} from "@ratel-ai/ratel-local-core";
import {
  type AgentPluginInstaller,
  attemptRatelAgentPluginInstall,
  unavailableAgentPluginInstaller,
} from "../../agent-plugin.js";
import { resolveCliRatelBin } from "../ratel-bin.js";
import type { HandlerCtx } from "./types.js";

export interface LinkOptions {
  yes?: boolean;
  bin?: ResolvedBin;
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  agentKind?: SupportedAgentHostKind;
  installPlugin?: AgentPluginInstaller;
  exists?: (path: string) => Promise<boolean>;
}

export const LINK_USAGE = `usage: ratel-local link [flags]

Flags:
  --agent auto|claude-code|codex
                              choose the agent to link (default: auto)
  --yes                       skip the confirmation prompt
  --help                      show this help`;

export async function runLink(
  ctx: HandlerCtx,
  opts: LinkOptions = {},
): Promise<BackupManifest | null> {
  ctx.prompts.intro("Ratel · link agent at Ratel");

  const agentHost = opts.agentKind
    ? new NamedAgentHostAdapter(opts.agentKind)
    : new AutomaticAgentHostAdapter();
  const detection = await agentHost.detect({ env: ctx.env, fs: ctx.fs });
  if (!detection.present) {
    const pluginHost = await findAgentHostRatelPluginConnection(ctx, opts.agentKind);
    if (pluginHost) {
      await reconcileExistingPlugin(
        ctx,
        opts,
        resolveHostKind(opts.agentKind, pluginHost.state.host.kind),
      );
      ctx.prompts.outro(
        pluginLinkNoOpMessage(pluginHost.state.host.displayName, pluginHost.connection),
      );
      return null;
    }
    ctx.prompts.note("No supported agent config found. Nothing to link.");
    ctx.prompts.outro("done");
    return null;
  }
  const agentState = await agentHost.read({ env: ctx.env, fs: ctx.fs });
  const hostKind = resolveHostKind(opts.agentKind, agentState.host.kind);
  const connection = await getAgentHostRatelConnection(hostKind, agentState, ctx);
  if (connection.plugin) {
    await reconcileExistingPlugin(ctx, opts, hostKind);
    ctx.prompts.outro(pluginLinkNoOpMessage(agentState.host.displayName, connection));
    return null;
  }

  const ratelUserPath = ratelConfigPath("user", ctx.env);
  const ratelProjectPath = ctx.env.projectRoot ? ratelConfigPath("project", ctx.env) : undefined;
  const ratelLocalPath = ctx.env.projectRoot ? ratelConfigPath("local", ctx.env) : undefined;

  let ratelUser = await readRatelConfig(ctx, ratelUserPath);
  const ratelProject = ratelProjectPath ? await readRatelConfig(ctx, ratelProjectPath) : null;
  const ratelLocal = ratelLocalPath ? await readRatelConfig(ctx, ratelLocalPath) : null;

  const implicitUserSkills =
    ratelUser?.skills?.dirs === undefined &&
    (await ctx.fs.list(join(ctx.env.homeDir, ".ratel", "skills"))).length > 0;
  if (implicitUserSkills) {
    ratelUser = {
      ...(ratelUser ?? parseConfig({})),
      skills: {
        ...(ratelUser?.skills ?? {}),
        dirs: [join(ctx.env.homeDir, ".ratel", "skills")],
      },
    };
  }
  const pluginChanges = buildAgentHostRatelPluginLinkChanges(hostKind, agentState, connection);
  const enablingPlugin = pluginChanges.length > 0;

  let plan: Pick<AgentImportDraft, "agentChanges">;
  if (enablingPlugin) {
    plan = { agentChanges: pluginChanges };
  } else {
    const bin = opts.bin ?? (await resolveBin(ctx, opts));

    plan = await buildAgentLinkPlan({
      agentHost,
      agentState,
      ratelUser,
      ratelProject,
      ratelLocal,
      bin,
      ratelUserPath,
      ratelProjectPath,
      ratelLocalPath,
      projectRoot: ctx.env.projectRoot,
    });
  }

  if (plan.agentChanges.length === 0) {
    ctx.prompts.outro(`nothing to do (${agentState.host.displayName} already points at Ratel)`);
    return null;
  }

  ctx.prompts.note(
    renderAgentStage(plan, enablingPlugin),
    `${agentState.host.displayName} rewrites`,
  );
  const preparedChange = ctx.preparedChanges
    ? await prepareCliLinkChange(ctx, plan.agentChanges, {
        hostKind,
        enablingPlugin,
        installPlugin:
          opts.installPlugin ?? ctx.installAgentPlugin ?? unavailableAgentPluginInstaller,
      })
    : null;

  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: enablingPlugin
        ? `Re-enable the Ratel Local plugin MCP server in ${agentState.host.displayName}?`
        : `Install the Ratel Local plugin for ${agentState.host.displayName}? If plugin installation fails, Ratel will write the reviewed MCP gateway fallback.`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      if (preparedChange) ctx.preparedChanges?.cancel(preparedChange.changeId);
      ctx.prompts.cancel("link cancelled");
      return null;
    }
  }

  if (preparedChange && ctx.preparedChanges) {
    const commit = await ctx.preparedChanges.commit<{
      mode: "plugin" | "mcp-fallback" | "config";
      message?: string;
    }>(preparedChange.changeId);
    if (commit.result.mode === "plugin") {
      ctx.prompts.note(commit.result.message ?? "Plugin installed", "Plugin installed");
      ctx.prompts.outro(
        `plugin link complete · reload or restart ${agentState.host.displayName} to load Ratel Local`,
      );
      return null;
    }
    if (commit.result.mode === "mcp-fallback") {
      ctx.prompts.note(
        `${commit.result.message ?? "Plugin installation failed"}\nFalling back to the reviewed explicit MCP gateway configuration.`,
        "Plugin installation failed",
      );
    }
    ctx.prompts.note(`Backup created. Run \`ratel-local backup list\` to inspect backups.`, "Done");
    ctx.prompts.outro(
      commit.result.mode === "mcp-fallback"
        ? `MCP fallback link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`
        : `link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`,
    );
    return commit.backupManifest;
  }

  throw new Error("prepared change coordinator is unavailable");
}

async function prepareCliLinkChange(
  ctx: HandlerCtx,
  changes: AgentImportDraft["agentChanges"],
  options: {
    hostKind: SupportedAgentHostKind;
    enablingPlugin: boolean;
    installPlugin: AgentPluginInstaller;
  },
) {
  if (!ctx.preparedChanges) throw new Error("prepared change coordinator is unavailable");
  return ctx.preparedChanges.prepare<
    { files: Array<{ path: string; before: string | null; after: string }> },
    { mode: "plugin" | "mcp-fallback" | "config"; message?: string }
  >({
    kind: "agent.link",
    operations: changes.map((change) => ({
      kind: "replace-file" as const,
      path: change.path,
      contents: change.after,
    })),
    buildPreview: (mutation) => {
      for (const change of changes) {
        const expected =
          change.before === null ? MISSING_DOCUMENT_REVISION : documentRevision(change.before);
        const actual = mutation.baseRevisions[change.path];
        if (actual !== expected) {
          throw new MutationConflictError(
            "revision_conflict",
            `document changed while preparing agent link: ${change.path}`,
            change.path,
            expected,
            actual,
          );
        }
      }
      return { files: changes.map(({ path, before, after }) => ({ path, before, after })) };
    },
    captureBackup: async () => {
      const backup = startBackup(ctx.env, ctx.fs);
      for (const change of changes) await backup.capture(change.path);
      return backup.finalize("link");
    },
    affectedContexts: [{ kind: "global" }],
    beforeCommit: options.enablingPlugin
      ? undefined
      : async () => {
          const plugin = await attemptRatelAgentPluginInstall(
            options.hostKind,
            options.installPlugin,
          );
          if (plugin.installed) {
            return {
              action: "cancel" as const,
              result: { mode: "plugin" as const, message: plugin.message },
            };
          }
          if (plugin.pluginAvailable) {
            throw new Error(plugin.message);
          }
          return {
            action: "commit" as const,
            result: { mode: "mcp-fallback" as const, message: plugin.message },
          };
        },
    result: { mode: "config" as const },
  });
}

async function reconcileExistingPlugin(
  ctx: HandlerCtx,
  opts: LinkOptions,
  hostKind: SupportedAgentHostKind,
): Promise<void> {
  const installPlugin =
    opts.installPlugin ?? ctx.installAgentPlugin ?? unavailableAgentPluginInstaller;
  const plugin = await attemptRatelAgentPluginInstall(hostKind, installPlugin, {
    reconcileMarketplace: true,
  });
  ctx.prompts.note(
    plugin.message,
    plugin.installed ? "Plugin channel ready" : "Plugin channel unchanged",
  );
  if (!plugin.installed) {
    throw new Error(plugin.message);
  }
}

function resolveHostKind(
  requested: SupportedAgentHostKind | undefined,
  detected: string,
): SupportedAgentHostKind {
  if (requested) return requested;
  if (detected === "claude-code" || detected === "codex") return detected;
  throw new Error(`Unsupported agent host ${JSON.stringify(detected)}`);
}

async function readRatelConfig(ctx: HandlerCtx, path: string): Promise<RatelConfig | null> {
  const document = await readJson<RatelConfigDocument>(ctx.fs, path);
  return document ? parseConfig(document) : null;
}

async function resolveBin(ctx: HandlerCtx, opts: LinkOptions): Promise<ResolvedBin> {
  return resolveCliRatelBin(ctx, {
    envVar: opts.envVar ?? process.env.RATEL_LOCAL_BIN,
    whichResult: opts.whichResult,
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
  });
}

function renderAgentStage(
  plan: Pick<AgentImportDraft, "agentChanges">,
  enablingPlugin: boolean,
): string {
  const lines = plan.agentChanges.map(
    (c) => `write ${c.path}${c.before === null ? " (new file)" : ""}`,
  );
  lines.push("");
  lines.push(
    enablingPlugin
      ? "The disabled Ratel Local plugin MCP server will be re-enabled. No explicit gateway will be added."
      : "Ratel will install the agent plugin first. If installation fails, the ratel-local gateway changes above will be written as an explicit MCP fallback. Native agent MCP entries are preserved.",
  );
  return lines.join("\n");
}
