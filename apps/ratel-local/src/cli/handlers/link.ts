import { join } from "node:path";
import type { BackupManifest, RatelConfig, RatelConfigDocument } from "@ratel-ai/ratel-local-core";
import {
  AutomaticAgentHostAdapter,
  buildAgentHostRatelPluginLinkChanges,
  buildAgentLinkPlan,
  findAgentHostRatelPluginConnection,
  getAgentHostRatelConnection,
  type ImportPlan,
  NamedAgentHostAdapter,
  pluginLinkNoOpMessage,
  executePlanTransactionally,
  type MutationEngine,
  parseConfig,
  type ResolvedBin,
  ratelConfigPath,
  readJson,
  type SupportedAgentHostKind,
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
  mutationEngine?: MutationEngine;
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

  let plan: Pick<ImportPlan, "agentChanges">;
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

  if (!opts.yes) {
    const ok = await ctx.prompts.confirm({
      message: enablingPlugin
        ? `Re-enable the Ratel Local plugin MCP server in ${agentState.host.displayName}?`
        : `Install the Ratel Local plugin for ${agentState.host.displayName}? If plugin installation fails, Ratel will write the reviewed MCP gateway fallback.`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(ok) || ok === false) {
      ctx.prompts.cancel("link cancelled");
      return null;
    }
  }

  let usedMcpFallback = false;
  if (!enablingPlugin) {
    const installPlugin =
      opts.installPlugin ?? ctx.installAgentPlugin ?? unavailableAgentPluginInstaller;
    const pluginResult = await attemptRatelAgentPluginInstall(hostKind, installPlugin);
    if (pluginResult.installed) {
      ctx.prompts.note(pluginResult.message, "Plugin installed");
      ctx.prompts.outro(
        `plugin link complete · reload or restart ${agentState.host.displayName} to load Ratel Local`,
      );
      return null;
    }
    usedMcpFallback = true;
    ctx.prompts.note(
      `${pluginResult.message}\nFalling back to the reviewed explicit MCP gateway configuration.`,
      "Plugin installation failed",
    );
  }

  const manifest = await (ctx.planExecutor ?? executePlanTransactionally)(plan.agentChanges, {
    fs: ctx.fs,
    env: ctx.env,
    action: "link",
    ...(opts.mutationEngine ? { mutationEngine: opts.mutationEngine } : {}),
  });
  ctx.prompts.note(`Backup created. Run \`ratel-local backup list\` to inspect backups.`, "Done");
  ctx.prompts.outro(
    usedMcpFallback
      ? `MCP fallback link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`
      : `link complete · restart ${agentState.host.displayName} to pick up the new MCP entry`,
  );
  return manifest;
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

function renderAgentStage(plan: Pick<ImportPlan, "agentChanges">, enablingPlugin: boolean): string {
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
