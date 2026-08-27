import type {
  AgentTraceChangeCommit,
  AgentTraceHostStatus,
  AgentTraceLevel,
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
  --level redacted|tool-details|full-content|tool-activity|prompt-content
                              host-aware telemetry detail level for enable
  --confirm-content           acknowledge content collection with --yes
  --json                      emit machine-readable status JSON
  --overwrite                 replace a conflicting exporter (irreversible)
  --yes                       accept the requested mutation non-interactively

Enable and disable require at least one --agent. Non-interactive conflict
replacement requires both --overwrite and --yes. Non-interactive content-bearing
levels require --level, --confirm-content, and --yes. Cloud telemetry mutations
also require RATEL_FEATURE_CLOUD_TELEMETRY=1 on the running daemon.`;

interface AgentTraceApiStatus extends AgentTraceStatus {
  featureEnabled?: boolean;
  cloudConfigured: boolean;
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
  const level = traceLevel(ctx.argv.flags.level, verb);
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
  if (status.featureEnabled === false) {
    throw new ArgError(
      "Cloud telemetry is disabled; start a foreground daemon with RATEL_FEATURE_CLOUD_TELEMETRY=1 or run RATEL_FEATURE_CLOUD_TELEMETRY=1 ratel-local daemon restart",
    );
  }

  const yes = booleanFlag(ctx.argv.flags.yes, "--yes");
  const overwriteFlag = booleanFlag(ctx.argv.flags.overwrite, "--overwrite");
  const confirmContent = booleanFlag(ctx.argv.flags["confirm-content"], "--confirm-content");
  const targetLevel = verb === "enable" ? (level ?? "redacted") : "off";
  const selectedStatuses = status.hosts.filter(({ hostKind }) => selected.includes(hostKind));
  validateHostLevels(selectedStatuses, targetLevel);
  const conflicts = selectedStatuses.filter((host) => targetConflicts(host, verb, targetLevel));
  let overwrite = overwriteFlag;

  if (isContentBearing(targetLevel)) {
    if (yes && !confirmContent) {
      throw new ArgError(
        "content-bearing telemetry levels require --confirm-content together with --yes in automation",
      );
    }
    if (!yes) {
      ctx.prompts.note(contentPrivacyWarning(targetLevel), "Sensitive telemetry content");
      const confirmed = await ctx.prompts.confirm({
        message: `Enable ${levelDisplayName(targetLevel)} for ${selected.map(displayName).join(" and ")}?`,
        initialValue: false,
      });
      if (ctx.prompts.isCancel(confirmed) || confirmed === false) {
        ctx.prompts.cancel("trace exporter setup cancelled");
        return;
      }
    }
  }

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
    body: { action: verb, level: targetLevel, hostKinds: selected, overwrite },
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
    ctx.log(
      `${host.displayName}: ${host.state} (${levelDisplayName(host.level)}) · start a new agent session to apply the change`,
    );
    for (const warning of host.warnings) ctx.log(`warning: ${warning}`);
  }
  if (!status.cloudConfigured && verb === "enable") {
    ctx.log(
      `Ratel Cloud is not configured. Store a key with "ratel-local cloud add <profile>"; create one at ${RATEL_CLOUD_SETTINGS_URL}.`,
    );
  }
}

async function readStatus(request: DaemonApiRequest): Promise<AgentTraceApiStatus> {
  const response = await request("/api/agent-traces");
  if (!response) throw daemonRequiredError();
  return requireDaemonJson<AgentTraceApiStatus>(response, "read native trace exporter status");
}

function renderStatus(ctx: HandlerCtx, status: AgentTraceApiStatus): void {
  for (const host of status.hosts) {
    ctx.log(
      `${host.displayName.padEnd(12)}${host.state.padEnd(11)}${levelDisplayName(host.level).padEnd(15)}${host.configPath}`,
    );
    if (host.conflictingFields.length > 0) {
      ctx.log(`  conflicts: ${host.conflictingFields.join(", ")}`);
    }
    for (const warning of host.warnings) ctx.log(`  warning: ${warning}`);
  }
  ctx.log(`Cloud telemetry feature: ${status.featureEnabled === false ? "disabled" : "enabled"}`);
  ctx.log(`Cloud relay: ${status.cloudConfigured ? "configured" : "not configured"}`);
}

function traceLevel(value: unknown, verb: string): AgentTraceLevel | undefined {
  if (value === undefined) return undefined;
  if (verb !== "enable") throw new ArgError("--level is valid only with traces enable");
  if (Array.isArray(value) || typeof value !== "string") {
    throw new ArgError(
      "--level requires redacted, tool-details, full-content, tool-activity, or prompt-content",
    );
  }
  if (
    value !== "redacted" &&
    value !== "tool-details" &&
    value !== "full-content" &&
    value !== "tool-activity" &&
    value !== "prompt-content"
  ) {
    throw new ArgError(
      "--level must be redacted, tool-details, full-content, tool-activity, or prompt-content",
    );
  }
  return value;
}

function validateHostLevels(hosts: AgentTraceHostStatus[], level: AgentTraceLevel): void {
  const unsupported = hosts.filter((host) => {
    const supported =
      host.supportedLevels ??
      (host.hostKind === "claude-code"
        ? ["off", "redacted", "tool-details", "full-content"]
        : ["off", "redacted", "tool-activity", "prompt-content"]);
    return !supported.includes(level);
  });
  if (unsupported.length > 0) {
    throw new ArgError(
      `${unsupported.map(({ displayName }) => displayName).join(" and ")} does not support the ${level} telemetry detail level`,
    );
  }
}

function isContentBearing(level: AgentTraceLevel): boolean {
  return (
    level === "tool-details" ||
    level === "full-content" ||
    level === "tool-activity" ||
    level === "prompt-content"
  );
}

function levelDisplayName(level: string): string {
  if (level === "off") return "Off";
  if (level === "redacted") return "Redacted";
  if (level === "tool-details") return "Tool details";
  if (level === "full-content") return "Full content";
  if (level === "tool-activity") return "Tool activity";
  if (level === "prompt-content") return "Prompt content";
  if (level === "custom") return "Custom content";
  return "Unknown";
}

function contentPrivacyWarning(level: AgentTraceLevel): string {
  if (level === "tool-details") {
    return "Tool details may include Claude tool parameters and arguments. Prompts and assistant responses remain disabled.";
  }
  if (level === "full-content") {
    return "Full content includes Claude user prompts, assistant responses, tool details, and tool content span events. It may contain source code, credentials, personal data, or other sensitive information.";
  }
  if (level === "tool-activity") {
    return "Codex structured tool logs include tool activity and codex.tool_result output snippets. User prompt logging remains disabled.";
  }
  return "Prompt content includes Codex user prompts and structured tool logs, whose codex.tool_result records may contain output snippets. Codex does not document assistant-response body capture.";
}

function targetConflicts(
  host: AgentTraceHostStatus,
  verb: "enable" | "disable",
  level: AgentTraceLevel,
): boolean {
  if (!host.signals) return host.state === "conflict";
  const owned = (state: string) => state === "configured" || state === "stale";
  if (verb === "disable") {
    return !owned(host.signals.traces) && !owned(host.signals.logs);
  }
  if (host.hostKind === "codex" && level === "redacted") {
    return host.signals.traces === "conflict";
  }
  return host.signals.traces === "conflict" || host.signals.logs === "conflict";
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
