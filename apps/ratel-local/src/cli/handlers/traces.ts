import type {
  AgentTraceChangeCommit,
  AgentTraceHostStatus,
  AgentTraceStatus,
  PreparedAgentTraceChange,
  SupportedAgentHostKind,
} from "@ratel-ai/ratel-local-core";
import { ArgError } from "../args.js";
import { type DaemonApiRequest, requestRunningDaemon, requireDaemonJson } from "../daemon-api.js";
import type { HandlerCtx } from "./types.js";

export const TRACES_USAGE = `usage: ratel-local traces <verb> [flags]

Verbs:
  status    show native trace exporter status (both agents by default)
  enable    route native traces to the running Ratel daemon
  disable   stop native trace export through Ratel

Flags:
  --agent claude-code|codex   select an agent; repeat for multiple agents
  --json                      emit machine-readable status JSON
  --overwrite                 replace a conflicting exporter (irreversible)
  --yes                       accept the requested mutation non-interactively

Enable and disable require at least one --agent. Non-interactive conflict
replacement requires both --overwrite and --yes.`;

interface AgentTraceApiStatus extends AgentTraceStatus {
  cloudConfigured: boolean;
}

interface CloudTraceSettingsStatus {
  configured: boolean;
  endpoint: string;
}

const RATEL_CLOUD_SETTINGS_URL = "https://cloud.ratel.sh/settings";

export interface TraceHandlerDependencies {
  request?: DaemonApiRequest;
  overwriteFlagName?: string;
}

export async function runTraces(
  ctx: HandlerCtx,
  dependencies: TraceHandlerDependencies = {},
): Promise<void> {
  const request = dependencies.request ?? ((path, init) => requestRunningDaemon(ctx, path, init));
  const verb = ctx.argv.verb;
  if (verb !== "status" && verb !== "enable" && verb !== "disable") {
    throw new ArgError(`unknown traces verb: ${verb}`);
  }

  const selected = selectedAgents(ctx.argv.flags.agent, verb !== "status");
  const status = await readStatus(request);
  if (verb === "status") {
    const json = booleanFlag(ctx.argv.flags.json, "--json");
    const filtered = {
      ...status,
      hosts:
        selected.length === 0
          ? status.hosts
          : status.hosts.filter(({ hostKind }) => selected.includes(hostKind)),
    };
    if (json) {
      ctx.log(JSON.stringify(filtered, null, 2));
    } else {
      renderStatus(ctx, filtered);
    }
    return;
  }

  const yes = booleanFlag(ctx.argv.flags.yes, "--yes");
  const overwriteFlag = booleanFlag(ctx.argv.flags.overwrite, "--overwrite");
  const selectedStatuses = status.hosts.filter(({ hostKind }) => selected.includes(hostKind));
  const conflicts = selectedStatuses.filter(({ state }) => state === "conflict");
  let overwrite = overwriteFlag;

  if (verb === "enable" && (overwriteFlag || conflicts.length > 0)) {
    if (yes && !overwriteFlag) {
      throw new ArgError(
        `conflicting exporters require both ${dependencies.overwriteFlagName ?? "--overwrite"} and --yes in automation`,
      );
    }
    if (!yes) {
      ctx.prompts.note(
        `${conflicts.length > 0 ? conflictSummary(conflicts) : "The selected exporter may be replaced."}\nNo backup is retained, so the previous exporter cannot be restored automatically.`,
        "Irreversible overwrite",
      );
      const confirmed = await ctx.prompts.confirm({
        message: "Replace the existing trace exporter configuration?",
        initialValue: false,
      });
      if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
        ctx.prompts.cancel("trace exporter setup cancelled");
        return;
      }
      overwrite = true;
    }
  } else if (!yes) {
    const confirmed = await ctx.prompts.confirm({
      message: `${verb === "enable" ? "Enable" : "Disable"} native trace export for ${selected.map(displayName).join(" and ")}?`,
      initialValue: true,
    });
    if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
      ctx.prompts.cancel("trace exporter setup cancelled");
      return;
    }
  }

  const preparedResponse = await request("/api/agent-traces/prepare", {
    method: "POST",
    body: { action: verb, hostKinds: selected, overwrite },
  });
  if (!preparedResponse) throw daemonRequiredError();
  const prepared = await requireDaemonJson<PreparedAgentTraceChange>(
    preparedResponse,
    `prepare trace exporter ${verb}`,
  );
  const commitResponse = await request(
    `/api/changes/${encodeURIComponent(prepared.changeId)}/commit`,
    { method: "POST" },
  );
  if (!commitResponse) {
    throw new Error("trace exporter change was prepared, but the daemon disappeared before commit");
  }
  const committed = await requireDaemonJson<AgentTraceChangeCommit>(
    commitResponse,
    `commit trace exporter ${verb}`,
  );
  for (const host of committed.result.hosts) {
    ctx.log(`${host.displayName}: ${host.state} · start a new agent session to apply the change`);
    for (const warning of host.warnings) ctx.log(`warning: ${warning}`);
  }
  if (!status.cloudConfigured && verb === "enable") {
    await offerCloudTraceSetup(ctx, request, yes);
  }
}

async function offerCloudTraceSetup(
  ctx: HandlerCtx,
  request: DaemonApiRequest,
  nonInteractive: boolean,
): Promise<void> {
  if (nonInteractive) {
    ctx.log(
      `Ratel Cloud tracing is not configured. Add an API key in Agent Setup or visit ${RATEL_CLOUD_SETTINGS_URL}.`,
    );
    return;
  }

  ctx.prompts.note(
    `If you don't have an API key, create one at ${RATEL_CLOUD_SETTINGS_URL}.`,
    "Ratel Cloud tracing",
  );
  const addKey = await ctx.prompts.confirm({
    message: "Ratel Cloud tracing is not configured. Would you like to add an API key?",
    initialValue: true,
  });
  if (ctx.prompts.isCancel(addKey) || addKey === false) return;

  const entered = await ctx.prompts.password({
    message: "Paste your Ratel Cloud API key",
    mask: "•",
  });
  if (ctx.prompts.isCancel(entered) || typeof entered !== "string" || entered.trim() === "") {
    ctx.prompts.note(
      `No API key was saved. You can configure one later in Agent Setup or at ${RATEL_CLOUD_SETTINGS_URL}.`,
      "Cloud setup skipped",
    );
    return;
  }

  const statusResponse = await request("/api/cloud-traces");
  if (!statusResponse) throw daemonRequiredError();
  const cloud = await requireDaemonJson<CloudTraceSettingsStatus>(
    statusResponse,
    "read Ratel Cloud trace settings",
  );
  if (typeof cloud.endpoint !== "string" || cloud.endpoint.trim() === "") {
    throw new Error("the daemon returned an invalid Ratel Cloud trace endpoint");
  }
  const saveResponse = await request("/api/cloud-traces", {
    method: "PATCH",
    body: { endpoint: cloud.endpoint, apiKey: entered.trim() },
  });
  if (!saveResponse) throw daemonRequiredError();
  await requireDaemonJson<CloudTraceSettingsStatus>(
    saveResponse,
    "save Ratel Cloud trace settings",
  );
  ctx.log("Ratel Cloud tracing configured.");
}

async function readStatus(request: DaemonApiRequest): Promise<AgentTraceApiStatus> {
  const response = await request("/api/agent-traces");
  if (!response) throw daemonRequiredError();
  return requireDaemonJson<AgentTraceApiStatus>(response, "read native trace exporter status");
}

function renderStatus(ctx: HandlerCtx, status: AgentTraceApiStatus): void {
  for (const host of status.hosts) {
    ctx.log(`${host.displayName.padEnd(12)}${host.state.padEnd(11)}${host.configPath}`);
    if (host.conflictingFields.length > 0) {
      ctx.log(`  conflicts: ${host.conflictingFields.join(", ")}`);
    }
    for (const warning of host.warnings) ctx.log(`  warning: ${warning}`);
  }
  ctx.log(`Cloud relay: ${status.cloudConfigured ? "configured" : "not configured"}`);
}

function selectedAgents(value: unknown, required: boolean): SupportedAgentHostKind[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const selected: SupportedAgentHostKind[] = [];
  for (const candidate of values) {
    if (candidate !== "claude-code" && candidate !== "codex") {
      throw new ArgError("--agent must be claude-code or codex");
    }
    if (!selected.includes(candidate)) selected.push(candidate);
  }
  if (required && selected.length === 0) {
    throw new ArgError("trace mutations require at least one --agent claude-code|codex");
  }
  return selected;
}

function booleanFlag(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ArgError(`${name} does not accept a value`);
  return value;
}

function displayName(kind: SupportedAgentHostKind): string {
  return kind === "claude-code" ? "Claude Code" : "Codex";
}

function conflictSummary(conflicts: AgentTraceHostStatus[]): string {
  return conflicts
    .map((host) => `${host.displayName}: ${host.conflictingFields.join(", ")}`)
    .join("\n");
}

function daemonRequiredError(): Error {
  return new Error("the Ratel daemon must be running to manage native trace exporters");
}
