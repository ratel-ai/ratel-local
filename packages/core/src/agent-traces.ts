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
export type AgentTraceState = "disabled" | "configured" | "stale" | "conflict" | "invalid";
export type AgentTraceAction = "enable" | "disable";

export interface AgentTraceContext {
  env: { homeDir: string };
  fs: JsonFs;
}

export interface AgentTraceHostStatus {
  hostKind: SupportedAgentHostKind;
  displayName: string;
  configPath: string;
  state: AgentTraceState;
  restartRequired: boolean;
  conflictingFields: string[];
  warnings: string[];
}

export interface AgentTraceStatus {
  endpoint: LoopbackTraceEndpoint;
  hosts: AgentTraceHostStatus[];
}

export interface AgentTraceHostChangeReview {
  hostKind: SupportedAgentHostKind;
  displayName: string;
  configPath: string;
  beforeState: AgentTraceState;
  afterState: AgentTraceState;
  changed: boolean;
  changedFields: string[];
  overwroteConflict: boolean;
  restartRequired: boolean;
  warnings: string[];
}

export interface AgentTraceChangeReview {
  action: AgentTraceAction;
  endpoint: LoopbackTraceEndpoint;
  hosts: AgentTraceHostChangeReview[];
}

export interface AgentTraceChangeResult {
  action: AgentTraceAction;
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

const CLAUDE_PRIVACY_FIELDS = [
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES",
] as const;

const CODEX_TRACE_FIELD = "otel.trace_exporter";

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
  const hosts = await Promise.all(
    hostKinds.map(async (hostKind) => {
      const path = agentTraceConfigPath(hostKind, ctx.env.homeDir);
      return inspectAgentTraceHost(hostKind, await ctx.fs.read(path), input.endpoint, path);
    }),
  );
  return { endpoint: input.endpoint, hosts };
}

export async function prepareAgentTraceChange(
  ctx: AgentTraceContext,
  input: {
    action: AgentTraceAction;
    hostKinds: readonly SupportedAgentHostKind[];
    endpoint: LoopbackTraceEndpoint;
    overwrite?: boolean;
    preparedChanges: PreparedChangeCoordinator;
  },
): Promise<PreparedAgentTraceChange> {
  const hostKinds = normalizeHostKinds(input.hostKinds, true);
  const documents = await Promise.all(
    hostKinds.map(async (hostKind) => {
      const path = agentTraceConfigPath(hostKind, ctx.env.homeDir);
      const text = await ctx.fs.read(path);
      return {
        hostKind,
        path,
        text,
        status: inspectAgentTraceHost(hostKind, text, input.endpoint, path),
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
  const conflicts = documents.filter(({ status }) => status.state === "conflict");
  if (conflicts.length > 0 && (input.action === "disable" || input.overwrite !== true)) {
    throw new AgentTraceConflictError(conflicts.map(({ status }) => status));
  }

  const operations: MutationInputOperation[] = [];
  const reviews: AgentTraceHostChangeReview[] = [];
  for (const document of documents) {
    const after =
      input.action === "disable" && document.status.state === "disabled"
        ? (document.text ?? "")
        : rewriteHost(document.hostKind, document.text, input.endpoint, input.action);
    const changed = after !== document.text && !(document.text === null && after === "");
    if (changed) {
      operations.push({ kind: "replace-file", path: document.path, contents: after });
    }
    const afterStatus = inspectAgentTraceHost(
      document.hostKind,
      changed ? after : document.text,
      input.endpoint,
      document.path,
    );
    reviews.push({
      hostKind: document.hostKind,
      displayName: document.status.displayName,
      configPath: document.path,
      beforeState: document.status.state,
      afterState: afterStatus.state,
      changed,
      changedFields:
        document.hostKind === "claude-code" ? [...CLAUDE_TRACE_FIELDS] : [CODEX_TRACE_FIELD],
      overwroteConflict: document.status.state === "conflict" && input.overwrite === true,
      restartRequired: changed,
      warnings: afterStatus.warnings,
    });
  }

  return input.preparedChanges.prepare({
    kind: `agent-traces.${input.action}`,
    operations,
    preview: { action: input.action, endpoint: input.endpoint, hosts: reviews },
    affectedContexts: [{ kind: "global" }],
    result: async () => ({
      action: input.action,
      hosts: (await getAgentTraceStatus(ctx, { endpoint: input.endpoint, hostKinds })).hosts,
    }),
  });
}

export function inspectAgentTraceHost(
  hostKind: SupportedAgentHostKind,
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  configPath = agentTraceConfigPath(hostKind, "/home/user"),
): AgentTraceHostStatus {
  return hostKind === "claude-code"
    ? inspectClaude(text, endpoint, configPath)
    : inspectCodex(text, endpoint, configPath);
}

export function rewriteClaudeTraceConfig(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
): string {
  const root = parseClaudeRoot(text);
  const env = root.env === undefined ? {} : plainStringRecord(root.env);
  if (!env) throw new AgentTraceValidationError("Claude Code settings env must be an object");
  const nextEnv: Record<string, unknown> = { ...env };
  if (action === "enable") {
    Object.assign(nextEnv, CLAUDE_TRACE_ENV, {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
    });
  } else {
    nextEnv.OTEL_TRACES_EXPORTER = "none";
    delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL;
    delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete nextEnv.OTEL_EXPORTER_OTLP_TRACES_HEADERS;
  }
  return `${JSON.stringify({ ...root, env: nextEnv }, null, 2)}\n`;
}

export function rewriteCodexTraceConfig(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
): string {
  parseCodexRoot(text);
  const assignment =
    action === "enable"
      ? `trace_exporter = { otlp-http = { endpoint = ${JSON.stringify(
          endpoint,
        )}, protocol = "binary", headers = {} } }`
      : 'trace_exporter = "none"';
  return insertOtelAssignment(removeCodexTraceExporter(text ?? ""), assignment);
}

function rewriteHost(
  hostKind: SupportedAgentHostKind,
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
  action: AgentTraceAction,
): string {
  return hostKind === "claude-code"
    ? rewriteClaudeTraceConfig(text, endpoint, action)
    : rewriteCodexTraceConfig(text, endpoint, action);
}

function inspectClaude(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
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
      [],
      ["Claude Code user settings are not valid JSON with a string-valued env object."],
    );
  }

  const warnings = CLAUDE_PRIVACY_FIELDS.filter((field) => env[field] === "1").map(
    (field) => `${field} is enabled; Claude trace spans may include additional sensitive content.`,
  );
  const selector = env.OTEL_TRACES_EXPORTER;
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const exact =
    selector === "otlp" &&
    traceEndpoint === endpoint &&
    Object.entries(CLAUDE_TRACE_ENV).every(([key, value]) => env[key] === value);
  if (exact) return hostStatus("claude-code", configPath, "configured", [], warnings);

  const stale =
    selector === "otlp" &&
    isRatelLoopbackEndpoint(traceEndpoint) &&
    Object.entries(CLAUDE_TRACE_ENV).every(([key, value]) => env[key] === value);
  if (stale) return hostStatus("claude-code", configPath, "stale", [], warnings);

  const routeFieldsPresent = CLAUDE_TRACE_FIELDS.some((field) => {
    if (field === "CLAUDE_CODE_ENABLE_TELEMETRY") return false;
    return env[field] !== undefined;
  });
  if ((selector === undefined || selector === "none") && !routeFieldsPresent) {
    return hostStatus("claude-code", configPath, "disabled", [], warnings);
  }

  const expected = { ...CLAUDE_TRACE_ENV, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint };
  const conflictingFields = CLAUDE_TRACE_FIELDS.filter(
    (field) => env[field] !== undefined && env[field] !== expected[field as keyof typeof expected],
  );
  if (conflictingFields.length === 0) {
    for (const field of CLAUDE_TRACE_FIELDS) {
      if (env[field] === undefined) conflictingFields.push(field);
    }
  }
  return hostStatus("claude-code", configPath, "conflict", conflictingFields, warnings);
}

function inspectCodex(
  text: string | null,
  endpoint: LoopbackTraceEndpoint,
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
      [],
      ["Codex user configuration is not valid TOML."],
    );
  }
  const otel = isPlainObject(root.otel) ? root.otel : {};
  const exporter = otel.trace_exporter;
  if (exporter === undefined || exporter === "none") {
    return hostStatus("codex", configPath, "disabled");
  }
  if (isPlainObject(exporter) && isPlainObject(exporter["otlp-http"])) {
    const http = exporter["otlp-http"] as Record<string, unknown>;
    const headersEmpty =
      http.headers === undefined ||
      (isPlainObject(http.headers) && Object.keys(http.headers).length === 0);
    const otherwiseExact =
      http.protocol === "binary" &&
      headersEmpty &&
      Object.keys(http).every((key) => ["endpoint", "protocol", "headers"].includes(key));
    if (otherwiseExact && http.endpoint === endpoint) {
      return hostStatus("codex", configPath, "configured");
    }
    if (otherwiseExact && isRatelLoopbackEndpoint(http.endpoint)) {
      return hostStatus("codex", configPath, "stale");
    }
  }
  return hostStatus("codex", configPath, "conflict", [CODEX_TRACE_FIELD]);
}

function hostStatus(
  hostKind: SupportedAgentHostKind,
  configPath: string,
  state: AgentTraceState,
  conflictingFields: string[] = [],
  warnings: string[] = [],
): AgentTraceHostStatus {
  return {
    hostKind,
    displayName: hostKind === "claude-code" ? "Claude Code" : "Codex",
    configPath,
    state,
    restartRequired: state === "configured" || state === "stale",
    conflictingFields: [...conflictingFields].sort(),
    warnings,
  };
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

function isRatelLoopbackEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.pathname === "/otlp/v1/traces" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
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

function removeCodexTraceExporter(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let section: string[] = [];
  let skipTraceTable = false;
  let skipAssignmentDepth: number | null = null;

  for (const line of lines) {
    const table = /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/.exec(line);
    if (table) {
      section = parseTomlPath(table[1]);
      skipTraceTable =
        section.length >= 2 && section[0] === "otel" && section[1] === "trace_exporter";
      skipAssignmentDepth = null;
      if (!skipTraceTable) out.push(line);
      continue;
    }
    if (skipTraceTable) continue;
    if (skipAssignmentDepth !== null) {
      skipAssignmentDepth += tomlBracketDelta(line);
      if (skipAssignmentDepth <= 0) skipAssignmentDepth = null;
      continue;
    }

    const assignment =
      section.length === 1 && section[0] === "otel"
        ? /^\s*(?:trace_exporter|"trace_exporter"|'trace_exporter')\s*=/.exec(line)
        : section.length === 0
          ? /^\s*(?:otel|"otel"|'otel')\.(?:trace_exporter|"trace_exporter"|'trace_exporter')\s*=/.exec(
              line,
            )
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
