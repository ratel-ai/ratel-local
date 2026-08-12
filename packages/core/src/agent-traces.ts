import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { SupportedAgentHostKind } from "./agent-host/index.js";
import type { JsonFs } from "./io.js";
import { isPlainObject } from "./json.js";
import type { MutationInputOperation } from "./mutation-engine.js";
import type {
  PreparedChange,
  PreparedChangeCommit,
  PreparedChangeCoordinator,
} from "./prepared-change-coordinator.js";

export type LoopbackTraceEndpoint = string & { readonly __brand: "LoopbackTraceEndpoint" };
export type LoopbackLogEndpoint = string & { readonly __brand: "LoopbackLogEndpoint" };
export type AgentTraceState = "disabled" | "configured" | "stale" | "conflict" | "invalid";
export type AgentTraceAction = "enable" | "disable";
export type AgentTraceLevel =
  | "off"
  | "redacted"
  | "tool-details"
  | "full-content"
  | "tool-activity"
  | "prompt-content";
export type AgentTraceObservedLevel = AgentTraceLevel | "custom" | "unknown";
export type AgentTraceEnabledLevel = Exclude<AgentTraceLevel, "off">;
export type AgentTelemetrySignalState = "disabled" | "configured" | "stale" | "conflict";

export interface AgentTraceContext {
  env: { homeDir: string };
  fs: JsonFs;
}

export interface AgentTraceHostStatus {
  hostKind: SupportedAgentHostKind;
  displayName: string;
  configPath: string;
  state: AgentTraceState;
  level: AgentTraceObservedLevel;
  supportedLevels: AgentTraceLevel[];
  signals: {
    traces: AgentTelemetrySignalState;
    logs: AgentTelemetrySignalState;
  };
  restartRequired: boolean;
  conflictingFields: string[];
  warnings: string[];
}

export interface AgentTraceStatus {
  endpoint: LoopbackTraceEndpoint;
  logsEndpoint: LoopbackLogEndpoint;
  hosts: AgentTraceHostStatus[];
}

export interface AgentTraceHostChangeReview {
  hostKind: SupportedAgentHostKind;
  displayName: string;
  configPath: string;
  beforeState: AgentTraceState;
  afterState: AgentTraceState;
  beforeLevel: AgentTraceObservedLevel;
  afterLevel: AgentTraceObservedLevel;
  changed: boolean;
  changedFields: string[];
  overwroteConflict: boolean;
  restartRequired: boolean;
  warnings: string[];
}

export interface AgentTraceChangeReview {
  action: AgentTraceAction;
  level: AgentTraceLevel;
  endpoint: LoopbackTraceEndpoint;
  logsEndpoint: LoopbackLogEndpoint;
  hosts: AgentTraceHostChangeReview[];
}

export interface AgentTraceChangeResult {
  action: AgentTraceAction;
  level: AgentTraceLevel;
  hosts: AgentTraceHostStatus[];
}

export type PreparedAgentTraceChange = PreparedChange<AgentTraceChangeReview>;
export type AgentTraceChangeCommit = PreparedChangeCommit<AgentTraceChangeResult>;

export class AgentTraceConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "AGENT_TRACE_CONFLICT";

  constructor(readonly conflicts: AgentTraceHostStatus[]) {
    super(
      `Native trace exporter conflict in ${conflicts.map((item) => item.displayName).join(", ")}`,
    );
    this.name = "AgentTraceConflictError";
  }
}

export class AgentTraceValidationError extends Error {
  readonly statusCode = 422;
  readonly code = "AGENT_TRACE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AgentTraceValidationError";
  }
}

const CLAUDE_TRACE_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
} as const;

const CLAUDE_TRACE_FIELDS = [
  ...Object.keys(CLAUDE_TRACE_ENV),
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
].sort();

const CLAUDE_LOG_ENV = {
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "",
} as const;

const CLAUDE_LOG_FIELDS = [
  ...Object.keys(CLAUDE_LOG_ENV),
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
].sort();

const CLAUDE_PRIVACY_FIELDS = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
] as const;

const CLAUDE_CONTENT_FIELDS = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
] as const;

const CLAUDE_SUPPORTED_LEVELS: AgentTraceLevel[] = [
  "off",
  "redacted",
  "tool-details",
  "full-content",
];
const CODEX_SUPPORTED_LEVELS: AgentTraceLevel[] = [
  "off",
  "redacted",
  "tool-activity",
  "prompt-content",
];

const CODEX_TRACE_FIELD = "otel.trace_exporter";
const CODEX_LOG_FIELD = "otel.exporter";
const CODEX_PROMPT_FIELD = "otel.log_user_prompt";

export function loopbackTraceEndpoint(value: string): LoopbackTraceEndpoint {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new AgentTraceValidationError("Agent trace endpoint must be a valid loopback URL");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port === "" ||
    Number(endpoint.port) < 1 ||
    endpoint.pathname !== "/otlp/v1/traces" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new AgentTraceValidationError(
      "Agent trace endpoint must be http://127.0.0.1:<port>/otlp/v1/traces",
    );
  }
  return endpoint.toString() as LoopbackTraceEndpoint;
}

export function loopbackLogEndpoint(traceEndpoint: LoopbackTraceEndpoint): LoopbackLogEndpoint {
  const endpoint = new URL(traceEndpoint);
  endpoint.pathname = "/otlp/v1/logs";
  return endpoint.toString() as LoopbackLogEndpoint;
}

export function agentTraceConfigPath(hostKind: SupportedAgentHostKind, homeDir: string): string {
  return hostKind === "claude-code"
    ? join(homeDir, ".claude", "settings.json")
    : join(homeDir, ".codex", "config.toml");
}

export async function getAgentTraceStatus(
  ctx: AgentTraceContext,
  input: { endpoint: LoopbackTraceEndpoint; hostKinds?: readonly SupportedAgentHostKind[] },
): Promise<AgentTraceStatus> {
  const hostKinds = normalizeHostKinds(input.hostKinds);
  const logsEndpoint = loopbackLogEndpoint(input.endpoint);
  const hosts = await Promise.all(
    hostKinds.map(async (hostKind) => {
      const path = agentTraceConfigPath(hostKind, ctx.env.homeDir);
      return inspectAgentTraceHost(
        hostKind,
        await ctx.fs.read(path),
        input.endpoint,
        path,
        logsEndpoint,
      );
    }),
  );
  return { endpoint: input.endpoint, logsEndpoint, hosts };
}

export async function prepareAgentTraceChange(
  ctx: AgentTraceContext,
  input: {
    action: AgentTraceAction;
    hostKinds: readonly SupportedAgentHostKind[];
    endpoint: LoopbackTraceEndpoint;
    level?: AgentTraceLevel;
    overwrite?: boolean;
    preparedChanges: PreparedChangeCoordinator;
  },
): Promise<PreparedAgentTraceChange> {
  const hostKinds = normalizeHostKinds(input.hostKinds, true);
  const targetLevel = normalizeTargetLevel(input.action, input.level, hostKinds);
  const logsEndpoint = loopbackLogEndpoint(input.endpoint);
  const documents = await Promise.all(
    hostKinds.map(async (hostKind) => {
      const path = agentTraceConfigPath(hostKind, ctx.env.homeDir);
      const text = await ctx.fs.read(path);
      return {
        hostKind,
        path,
        text,
        status: inspectAgentTraceHost(hostKind, text, input.endpoint, path, logsEndpoint),
      };
    }),
  );

  const invalid = documents.filter(({ status }) => status.state === "invalid");
  if (invalid.length > 0) {
    throw new AgentTraceValidationError(
      `Cannot ${input.action} native traces because ${invalid
        .map(({ status }) => status.displayName)
        .join(", ")} configuration is invalid`,
    );
  }
  const conflicts = documents.filter(({ hostKind, status }) =>
    hasTargetConflict(hostKind, status, input.action, targetLevel),
  );
  if (conflicts.length > 0 && input.overwrite !== true) {
    throw new AgentTraceConflictError(conflicts.map(({ status }) => status));
  }

  const operations: MutationInputOperation[] = [];
  const reviews: AgentTraceHostChangeReview[] = [];
  for (const document of documents) {
    const after =
      input.action === "disable" && document.status.state === "disabled"
        ? (document.text ?? "")
        : rewriteHost(
            document.hostKind,
            document.text,
            input.endpoint,
            input.action,
            targetLevel,
            logsEndpoint,
          );
    const changed = after !== document.text && !(document.text === null && after === "");
    if (changed) {
      operations.push({ kind: "replace-file", path: document.path, contents: after });
    }
    const afterStatus = inspectAgentTraceHost(
      document.hostKind,
      changed ? after : document.text,
      input.endpoint,
      document.path,
      logsEndpoint,
    );
    reviews.push({
      hostKind: document.hostKind,
      displayName: document.status.displayName,
      configPath: document.path,
      beforeState: document.status.state,
      afterState: afterStatus.state,
      beforeLevel: document.status.level,
      afterLevel: afterStatus.level,
      changed,
      changedFields:
        document.hostKind === "claude-code"
          ? [...CLAUDE_TRACE_FIELDS, ...CLAUDE_LOG_FIELDS, ...CLAUDE_CONTENT_FIELDS].sort()
          : [CODEX_TRACE_FIELD, CODEX_LOG_FIELD, CODEX_PROMPT_FIELD],
      overwroteConflict:
        hasTargetConflict(document.hostKind, document.status, input.action, targetLevel) &&
        input.overwrite === true,
      restartRequired: changed,
      warnings: afterStatus.warnings,
    });
  }

  return input.preparedChanges.prepare({
    kind: `agent-traces.${input.action}`,
    operations,
    preview: {
      action: input.action,
      level: targetLevel,
      endpoint: input.endpoint,
      logsEndpoint,
      hosts: reviews,
    },
    affectedContexts: [{ kind: "global" }],
    result: async () => ({
      action: input.action,
      level: targetLevel,
      hosts: (await getAgentTraceStatus(ctx, { endpoint: input.endpoint, hostKinds })).hosts,
    }),
  });
}

export function inspectAgentTraceHost(
  hostKind: SupportedAgentHostKind,
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  configPath = agentTraceConfigPath(hostKind, "/home/user"),
  logsEndpoint = loopbackLogEndpoint(endpoint),
): AgentTraceHostStatus {
  return hostKind === "claude-code"
    ? inspectClaude(text, endpoint, logsEndpoint, configPath)
    : inspectCodex(text, endpoint, logsEndpoint, configPath);
}

export function rewriteClaudeTraceConfig(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
  level: AgentTraceEnabledLevel = "redacted",
  logsEndpoint = loopbackLogEndpoint(endpoint),
): string {
  const root = parseClaudeRoot(text);
  const env = root.env === undefined ? {} : plainStringRecord(root.env);
  if (!env) throw new AgentTraceValidationError("Claude Code settings env must be an object");
  const nextEnv: Record<string, unknown> = { ...env };
  if (action === "enable") {
    if (level !== "redacted" && level !== "tool-details" && level !== "full-content") {
      throw new AgentTraceValidationError("Unsupported Claude Code telemetry detail level");
    }
    const content = claudeContentEnv(level);
    Object.assign(
      nextEnv,
      CLAUDE_TRACE_ENV,
      {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      },
      CLAUDE_LOG_ENV,
      {
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsEndpoint,
      },
      content,
    );
  } else {
    const traceSignal = inspectClaudeRoute(env, "traces", endpoint);
    const logSignal = inspectClaudeRoute(env, "logs", logsEndpoint);
    let removedRatelRoute = false;
    if (isOwnedSignal(traceSignal)) {
      if (nextEnv.OTEL_TRACES_EXPORTER === "otlp") nextEnv.OTEL_TRACES_EXPORTER = "none";
      delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
      delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
      removedRatelRoute = true;
    }
    if (isOwnedSignal(logSignal)) {
      if (nextEnv.OTEL_LOGS_EXPORTER === "otlp") nextEnv.OTEL_LOGS_EXPORTER = "none";
      delete nextEnv.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL;
      delete nextEnv.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      delete nextEnv.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
      removedRatelRoute = true;
    }
    if (removedRatelRoute) Object.assign(nextEnv, claudeContentEnv("redacted"));
  }
  return `${JSON.stringify({ ...root, env: nextEnv }, null, 2)}\n`;
}

export function rewriteCodexTraceConfig(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
  level: AgentTraceEnabledLevel = "redacted",
  logsEndpoint = loopbackLogEndpoint(endpoint),
): string {
  const root = parseCodexRoot(text);
  const otel = isPlainObject(root.otel) ? root.otel : {};
  const traceSignal = inspectCodexRoute(otel.trace_exporter, endpoint, "traces");
  const logSignal = inspectCodexRoute(otel.exporter, logsEndpoint, "logs");
  const assignments = new Map<string, string>();

  if (action === "disable") {
    if (isOwnedSignal(traceSignal)) assignments.set("trace_exporter", 'trace_exporter = "none"');
    if (isOwnedSignal(logSignal)) {
      assignments.set("exporter", 'exporter = "none"');
      assignments.set("log_user_prompt", "log_user_prompt = false");
    }
    if (assignments.size === 0) return text ?? "";
    return rewriteCodexOtelFields(text ?? "", assignments);
  }

  assignments.set(
    "trace_exporter",
    `trace_exporter = { otlp-http = { endpoint = ${JSON.stringify(endpoint)}, protocol = "binary", headers = {} } }`,
  );
  if (level === "redacted") {
    if (isOwnedSignal(logSignal)) {
      assignments.set("exporter", 'exporter = "none"');
      assignments.set("log_user_prompt", "log_user_prompt = false");
    }
  } else if (level === "tool-activity" || level === "prompt-content") {
    assignments.set(
      "exporter",
      `exporter = { otlp-http = { endpoint = ${JSON.stringify(logsEndpoint)}, protocol = "binary", headers = {} } }`,
    );
    assignments.set(
      "log_user_prompt",
      `log_user_prompt = ${level === "prompt-content" ? "true" : "false"}`,
    );
  } else {
    throw new AgentTraceValidationError("Unsupported Codex telemetry detail level");
  }
  return rewriteCodexOtelFields(text ?? "", assignments);
}

function rewriteHost(
  hostKind: SupportedAgentHostKind,
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
  level: AgentTraceLevel,
  logsEndpoint: LoopbackLogEndpoint,
): string {
  const enabledLevel = level === "off" ? "redacted" : level;
  return hostKind === "claude-code"
    ? rewriteClaudeTraceConfig(text, endpoint, action, enabledLevel, logsEndpoint)
    : rewriteCodexTraceConfig(text, endpoint, action, enabledLevel, logsEndpoint);
}

function inspectClaude(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  logsEndpoint: LoopbackLogEndpoint,
  configPath: string,
): AgentTraceHostStatus {
  let root: Record<string, unknown>;
  let env: Record<string, string>;
  try {
    root = parseClaudeRoot(text);
    const parsedEnv = root.env === undefined ? {} : plainStringRecord(root.env);
    if (!parsedEnv) throw new Error("invalid env");
    env = parsedEnv;
  } catch {
    return hostStatus(
      "claude-code",
      configPath,
      "invalid",
      "unknown",
      [],
      ["Claude Code user settings are not valid JSON with a string-valued env object."],
    );
  }

  const warnings = CLAUDE_PRIVACY_FIELDS.filter((field) => env[field] === "1").map(
    (field) => `${field} is enabled; Claude telemetry may include additional sensitive content.`,
  );
  const traceSignal = inspectClaudeRoute(env, "traces", endpoint);
  const logSignal = inspectClaudeRoute(env, "logs", logsEndpoint);
  const signals = { traces: traceSignal, logs: logSignal };
  const level = inspectClaudeLevel(env);
  const owned = isOwnedSignal(traceSignal) || isOwnedSignal(logSignal);
  const baseConflicts = Object.entries({
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
  })
    .filter(([field, expected]) => env[field] !== undefined && env[field] !== expected)
    .map(([field]) => field);
  const conflictingFields = [
    ...baseConflicts,
    ...claudeRouteConflictingFields(env, "traces", endpoint, traceSignal),
    ...claudeRouteConflictingFields(env, "logs", logsEndpoint, logSignal),
  ];
  if (!owned) {
    if (traceSignal === "disabled" && logSignal === "disabled") {
      return hostStatus("claude-code", configPath, "disabled", "off", [], warnings, signals);
    }
    return hostStatus(
      "claude-code",
      configPath,
      "conflict",
      "unknown",
      conflictingFields,
      warnings,
      signals,
    );
  }
  if (baseConflicts.length > 0 || traceSignal === "conflict" || logSignal === "conflict") {
    return hostStatus(
      "claude-code",
      configPath,
      "conflict",
      "unknown",
      conflictingFields,
      warnings,
      signals,
    );
  }
  const baseMissing =
    env.CLAUDE_CODE_ENABLE_TELEMETRY !== "1" || env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA !== "1";
  const state =
    traceSignal === "configured" && logSignal === "configured" && !baseMissing
      ? "configured"
      : "stale";
  if (logSignal === "disabled") {
    warnings.push("Claude log routing is not configured; reapply this level to add it.");
  }
  return hostStatus("claude-code", configPath, state, level, [], warnings, signals);
}

function inspectCodex(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  logsEndpoint: LoopbackLogEndpoint,
  configPath: string,
): AgentTraceHostStatus {
  let root: Record<string, unknown>;
  try {
    root = parseCodexRoot(text);
  } catch {
    return hostStatus(
      "codex",
      configPath,
      "invalid",
      "unknown",
      [],
      ["Codex user configuration is not valid TOML."],
    );
  }
  const otel = isPlainObject(root.otel) ? root.otel : {};
  const traceSignal = inspectCodexRoute(otel.trace_exporter, endpoint, "traces");
  const logSignal = inspectCodexRoute(otel.exporter, logsEndpoint, "logs");
  const signals = { traces: traceSignal, logs: logSignal };
  const traceOwned = isOwnedSignal(traceSignal);
  const logsOwned = isOwnedSignal(logSignal);
  const prompt = otel.log_user_prompt;
  const warnings: string[] = [];
  if (logsOwned) {
    warnings.push("Codex tool_result log records may include an output snippet.");
    if (prompt === true) warnings.push("Codex user prompt content is enabled in OTel logs.");
  }
  if (!traceOwned && !logsOwned) {
    if (traceSignal === "disabled" && logSignal === "disabled") {
      return hostStatus("codex", configPath, "disabled", "off", [], warnings, signals);
    }
    return hostStatus(
      "codex",
      configPath,
      "conflict",
      "unknown",
      [
        ...(traceSignal === "conflict" ? [CODEX_TRACE_FIELD] : []),
        ...(logSignal === "conflict" ? [CODEX_LOG_FIELD] : []),
      ],
      warnings,
      signals,
    );
  }

  const level: AgentTraceObservedLevel = logsOwned
    ? prompt === true
      ? "prompt-content"
      : prompt === false || prompt === undefined
        ? "tool-activity"
        : "custom"
    : traceOwned
      ? "redacted"
      : "custom";
  const conflictingFields = [
    ...(traceSignal === "conflict" ? [CODEX_TRACE_FIELD] : []),
    ...(logSignal === "conflict" ? [CODEX_LOG_FIELD] : []),
    ...(logsOwned && prompt !== undefined && typeof prompt !== "boolean"
      ? [CODEX_PROMPT_FIELD]
      : []),
  ];
  if (traceSignal === "conflict" || (logsOwned && conflictingFields.length > 0)) {
    return hostStatus("codex", configPath, "conflict", level, conflictingFields, warnings, signals);
  }
  const state =
    traceSignal === "stale" || logSignal === "stale" || (!traceOwned && logsOwned)
      ? "stale"
      : "configured";
  if (traceOwned && logSignal === "conflict") {
    warnings.push(
      "An unrelated Codex log exporter is preserved; logs-enabled levels need overwrite approval.",
    );
  }
  return hostStatus("codex", configPath, state, level, conflictingFields, warnings, signals);
}

function hostStatus(
  hostKind: SupportedAgentHostKind,
  configPath: string,
  state: AgentTraceState,
  level: AgentTraceObservedLevel = "unknown",
  conflictingFields: string[] = [],
  warnings: string[] = [],
  signals: AgentTraceHostStatus["signals"] = { traces: "disabled", logs: "disabled" },
): AgentTraceHostStatus {
  return {
    hostKind,
    displayName: hostKind === "claude-code" ? "Claude Code" : "Codex",
    configPath,
    state,
    level,
    supportedLevels:
      hostKind === "claude-code" ? [...CLAUDE_SUPPORTED_LEVELS] : [...CODEX_SUPPORTED_LEVELS],
    signals,
    restartRequired: state === "configured" || state === "stale",
    conflictingFields: [...conflictingFields].sort(),
    warnings,
  };
}

function claudeContentEnv(
  level: AgentTraceEnabledLevel,
): Record<(typeof CLAUDE_CONTENT_FIELDS)[number], "0" | "1"> {
  return {
    OTEL_LOG_USER_PROMPTS: level === "full-content" ? "1" : "0",
    OTEL_LOG_ASSISTANT_RESPONSES: level === "full-content" ? "1" : "0",
    OTEL_LOG_TOOL_DETAILS: level === "tool-details" || level === "full-content" ? "1" : "0",
    OTEL_LOG_TOOL_CONTENT: level === "full-content" ? "1" : "0",
  };
}

function inspectClaudeLevel(env: Record<string, string>): AgentTraceObservedLevel {
  const enabled = (field: (typeof CLAUDE_CONTENT_FIELDS)[number]) => env[field] === "1";
  const userPrompts = enabled("OTEL_LOG_USER_PROMPTS");
  const assistantResponses = enabled("OTEL_LOG_ASSISTANT_RESPONSES");
  const toolDetails = enabled("OTEL_LOG_TOOL_DETAILS");
  const toolContent = enabled("OTEL_LOG_TOOL_CONTENT");
  if (!userPrompts && !assistantResponses && !toolDetails && !toolContent) return "redacted";
  if (!userPrompts && !assistantResponses && toolDetails && !toolContent) return "tool-details";
  if (userPrompts && assistantResponses && toolDetails && toolContent) return "full-content";
  return "custom";
}

function normalizeTargetLevel(
  action: AgentTraceAction,
  level: AgentTraceLevel | undefined,
  hostKinds: readonly SupportedAgentHostKind[],
): AgentTraceLevel {
  if (action === "disable") {
    if (level !== undefined && level !== "off") {
      throw new AgentTraceValidationError("Disable accepts only the off trace detail level");
    }
    return "off";
  }
  const target = level ?? "redacted";
  if (!CLAUDE_SUPPORTED_LEVELS.includes(target) && !CODEX_SUPPORTED_LEVELS.includes(target)) {
    throw new AgentTraceValidationError("Unknown native trace detail level");
  }
  if (target === "off") {
    throw new AgentTraceValidationError("Enable requires a non-off trace detail level");
  }
  if (hostKinds.includes("claude-code") && !CLAUDE_SUPPORTED_LEVELS.includes(target)) {
    throw new AgentTraceValidationError(
      `Claude Code does not support the ${target} telemetry detail level`,
    );
  }
  if (hostKinds.includes("codex") && !CODEX_SUPPORTED_LEVELS.includes(target)) {
    throw new AgentTraceValidationError(
      `Codex does not support the ${target} telemetry detail level`,
    );
  }
  return target;
}

function parseClaudeRoot(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AgentTraceValidationError("Claude Code user settings are not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new AgentTraceValidationError("Claude Code user settings root must be an object");
  }
  return parsed;
}

function parseCodexRoot(text: string | null): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  const parsed = parseToml(text);
  if (!isPlainObject(parsed)) {
    throw new AgentTraceValidationError("Codex user configuration root must be a table");
  }
  if (parsed.otel !== undefined && !isPlainObject(parsed.otel)) {
    throw new AgentTraceValidationError("Codex otel configuration must be a table");
  }
  return parsed;
}

function plainStringRecord(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") return null;
    out[key] = item;
  }
  return out;
}

function isRatelLoopbackEndpoint(value: unknown, signal: "traces" | "logs"): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === `/otlp/v1/${signal}` &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function inspectClaudeRoute(
  env: Record<string, string>,
  signal: "traces" | "logs",
  endpoint: LoopbackTraceEndpoint | LoopbackLogEndpoint,
): AgentTelemetrySignalState {
  const upper = signal.toUpperCase();
  const exporter = env[`OTEL_${upper}_EXPORTER`];
  const protocol = env[`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`];
  const configuredEndpoint = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`];
  const headers = env[`OTEL_EXPORTER_OTLP_${upper}_HEADERS`];
  const hasSignalConfig =
    exporter !== undefined ||
    protocol !== undefined ||
    configuredEndpoint !== undefined ||
    headers !== undefined;
  if (!hasSignalConfig || (exporter === "none" && configuredEndpoint === undefined)) {
    return "disabled";
  }
  if (!isRatelLoopbackEndpoint(configuredEndpoint, signal)) return "conflict";
  const validShape = exporter === "otlp" && protocol === "http/protobuf" && headers === "";
  if (configuredEndpoint === endpoint && !validShape) return "conflict";
  if (configuredEndpoint === endpoint && validShape) {
    return "configured";
  }
  return "stale";
}

function claudeRouteConflictingFields(
  env: Record<string, string>,
  signal: "traces" | "logs",
  endpoint: LoopbackTraceEndpoint | LoopbackLogEndpoint,
  state: AgentTelemetrySignalState,
): string[] {
  if (state !== "conflict") return [];
  const upper = signal.toUpperCase();
  const expected: Record<string, string> = {
    [`OTEL_${upper}_EXPORTER`]: "otlp",
    [`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`]: "http/protobuf",
    [`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`]: endpoint,
    [`OTEL_EXPORTER_OTLP_${upper}_HEADERS`]: "",
  };
  const configuredEndpoint = env[`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`];
  if (configuredEndpoint === endpoint) {
    return Object.entries(expected)
      .filter(([field, value]) => env[field] !== value)
      .map(([field]) => field);
  }
  return Object.keys(expected).filter((field) => env[field] !== undefined);
}

function inspectCodexRoute(
  exporter: unknown,
  endpoint: LoopbackTraceEndpoint | LoopbackLogEndpoint,
  signal: "traces" | "logs",
): AgentTelemetrySignalState {
  if (exporter === undefined || exporter === "none") return "disabled";
  if (!isPlainObject(exporter)) return "conflict";
  const otlpHttp = exporter["otlp-http"];
  if (!isPlainObject(otlpHttp)) return "conflict";
  if (!isRatelLoopbackEndpoint(otlpHttp.endpoint, signal)) return "conflict";
  const validShape =
    otlpHttp.protocol === "binary" &&
    isPlainObject(otlpHttp.headers) &&
    Object.keys(otlpHttp.headers).length === 0;
  if (otlpHttp.endpoint === endpoint && !validShape) return "conflict";
  if (otlpHttp.endpoint === endpoint && validShape) {
    return "configured";
  }
  return "stale";
}

function isOwnedSignal(state: AgentTelemetrySignalState): boolean {
  return state === "configured" || state === "stale";
}

function hasTargetConflict(
  hostKind: SupportedAgentHostKind,
  status: AgentTraceHostStatus,
  action: AgentTraceAction,
  level: AgentTraceLevel,
): boolean {
  if (action === "disable") {
    return (
      status.state === "conflict" &&
      !isOwnedSignal(status.signals.traces) &&
      !isOwnedSignal(status.signals.logs)
    );
  }
  if (hostKind === "codex" && level === "redacted") {
    return status.signals.traces === "conflict";
  }
  return status.signals.traces === "conflict" || status.signals.logs === "conflict";
}

function normalizeHostKinds(
  hostKinds: readonly SupportedAgentHostKind[] | undefined,
  required = false,
): SupportedAgentHostKind[] {
  const values = hostKinds ?? ["claude-code", "codex"];
  const unique = [...new Set(values)];
  if (required && unique.length === 0) {
    throw new AgentTraceValidationError("At least one agent host is required");
  }
  for (const value of unique) {
    if (value !== "claude-code" && value !== "codex") {
      throw new AgentTraceValidationError("Agent host must be claude-code or codex");
    }
  }
  return unique;
}

function rewriteCodexOtelFields(text: string, assignments: ReadonlyMap<string, string>): string {
  let next = text;
  for (const field of assignments.keys()) next = removeCodexOtelField(next, field);
  for (const assignment of assignments.values()) next = insertOtelAssignment(next, assignment);
  return next;
}

function removeCodexOtelField(text: string, field: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let section: string[] = [];
  let skipFieldTable = false;
  let skipAssignmentDepth: number | null = null;

  for (const line of lines) {
    const table = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      section = parseTomlPath(table[1]);
      skipFieldTable = section.length >= 2 && section[0] === "otel" && section[1] === field;
      skipAssignmentDepth = null;
      if (!skipFieldTable) out.push(line);
      continue;
    }
    if (skipFieldTable) continue;
    if (skipAssignmentDepth !== null) {
      skipAssignmentDepth += tomlBracketDelta(line);
      if (skipAssignmentDepth <= 0) skipAssignmentDepth = null;
      continue;
    }

    const localAssignment = new RegExp(`^\\s*(?:${field}|"${field}"|'${field}')\\s*=`);
    const dottedAssignment = new RegExp(
      `^\\s*(?:otel|"otel"|'otel')\\.(?:${field}|"${field}"|'${field}')\\s*=`,
    );
    const assignment =
      section.length === 1 && section[0] === "otel"
        ? localAssignment.exec(line)
        : section.length === 0
          ? dottedAssignment.exec(line)
          : null;
    if (assignment) {
      const right = line.slice(line.indexOf("=", assignment.index) + 1);
      const depth = tomlBracketDelta(right);
      if (depth > 0) skipAssignmentDepth = depth;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function insertOtelAssignment(text: string, assignment: string): string {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const otelIndex = lines.findIndex((line) => /^\s*\[otel\]\s*(?:#.*)?$/.test(line));
  if (otelIndex < 0) {
    const prefix = lines.length === 1 && lines[0] === "" ? [] : lines;
    return `${[...prefix, "", "[otel]", assignment].join("\n").replace(/^\n/, "")}\n`;
  }
  let insertAt = lines.length;
  for (let index = otelIndex + 1; index < lines.length; index++) {
    if (/^\s*\[/.test(lines[index])) {
      insertAt = index;
      break;
    }
  }
  while (insertAt > otelIndex + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, assignment, "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseTomlPath(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (quote === '"' && char === "\\" && index + 1 < input.length) {
        current += input[++index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ".") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.filter(Boolean);
}

function tomlBracketDelta(value: string): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote && value[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return depth;
}
