export interface ServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  /** OAuth: explicit client_id when DCR isn't supported. http/sse only. */
  clientId?: string;
  /** OAuth: client_secret for confidential clients. http/sse only. */
  clientSecret?: string;
  /** OAuth: pinned redirect-URI port; required when the auth server expects a fixed URI. http/sse only. */
  callbackPort?: number;
  /** OAuth: initial requested scope. http/sse only. */
  scope?: string;
  [k: string]: unknown;
}

const HTTP_ONLY_FIELDS = ["callbackPort", "clientId", "clientSecret", "scope"] as const;

/** Ratel-managed skills: directories scanned for `<name>/SKILL.md`. */
export interface SkillsConfig {
  dirs?: string[];
}

/** Where captured chat comes from. `hooks` reads local capture files; `api`/`cloud` pull remotely. */
export type ChatSourceKind = "hooks" | "api" | "cloud";

/** Which intent-extraction backend to use. `http` is a local sidecar or remote endpoint. */
export type ExtractorProvider = "http" | "naive" | "cloud";

/** How a skill draft is generated. `auto` picks anthropic-api when a key is set, else claude-cli. */
export type SkillGenProvider = "auto" | "anthropic-api" | "claude-cli";

/** Intent-extraction backend: an HTTP endpoint (local sidecar, remote, or cloud) + optional auth. */
export interface ExtractorConfig {
  provider?: ExtractorProvider;
  /** Base URL of the extractor HTTP service (local Apple-Silicon sidecar, Docker box, or cloud). */
  endpoint?: string;
  /** Bearer key for a remote/cloud endpoint. Secret-bearing — masked when read back over the UI. */
  apiKey?: string;
  /** Model identifier the endpoint should serve, e.g. "claim-extractor-4B". */
  model?: string;
}

/** When the analysis runner fires. Manual is always available; these are the automatic triggers. */
export interface CadenceConfig {
  /**
   * Master switch for the background scheduler: when true, the gateway runs
   * analysis automatically on a timer (subject to the triggers below). Defaults
   * to false — automatic runs are opt-in; manual "Run now" always works.
   */
  auto?: boolean;
  /** Trigger after this many new captured turns. Must be a positive integer (default 10). */
  everyNMessages?: number;
  /** Also trigger when a session goes idle (driven by the Stop hook). */
  onIdle?: boolean;
  /**
   * Limit automatic/bulk runs to chats active within this many hours (a positive
   * number; fractional allowed). Omitted = no limit (analyze every due chat).
   * Per-chat manual analysis ignores this.
   */
  recentHours?: number;
}

/** Skill-draft generation backend. */
export interface SkillGenConfig {
  provider?: SkillGenProvider;
  /** Anthropic API key. Secret-bearing — masked when read back over the UI. */
  apiKey?: string;
  /** Model id/alias the skill generator should use (e.g. an Anthropic model id, or a `claude -p` alias like 'haiku'/'sonnet'). Optional; the generator falls back to its default. */
  model?: string;
}

/** Thresholds for deciding which skills "cover" an intent (BM25 search results). */
export interface CoverageConfig {
  /** Absolute BM25 floor: a skill scoring below this never covers an intent. */
  minScore?: number;
  /** Keep only skills within this fraction (0–1) of the top match for an intent. */
  relativeRatio?: number;
  /** Max skills reported as covering one intent. */
  maxSkills?: number;
}

/** Chat → intent extraction pipeline settings. All optional; UI-configurable at user scope. */
export interface AnalysisConfig {
  enabled?: boolean;
  chatSource?: ChatSourceKind;
  extractor?: ExtractorConfig;
  cadence?: CadenceConfig;
  skillGen?: SkillGenConfig;
  coverage?: CoverageConfig;
}

export interface RatelConfig {
  mcpServers: Record<string, ServerEntry>;
  skills?: SkillsConfig;
  analysis?: AnalysisConfig;
}

export function parseConfig(input: unknown): RatelConfig {
  if (!isPlainObject(input)) {
    throw new ConfigError("root must be a JSON object");
  }
  const mcpServers = (input as Record<string, unknown>).mcpServers;
  if (!isPlainObject(mcpServers)) {
    throw new ConfigError("`mcpServers` must be a JSON object");
  }

  const out: Record<string, ServerEntry> = {};
  for (const [name, raw] of Object.entries(mcpServers)) {
    out[name] = parseEntry(`mcpServers.${name}`, raw);
  }

  const config: RatelConfig = { mcpServers: out };
  const skills = (input as Record<string, unknown>).skills;
  if (skills !== undefined) {
    config.skills = parseSkills(skills);
  }
  const analysis = (input as Record<string, unknown>).analysis;
  if (analysis !== undefined) {
    config.analysis = parseAnalysis(analysis);
  }
  return config;
}

const CHAT_SOURCES: readonly ChatSourceKind[] = ["hooks", "api", "cloud"];
const EXTRACTOR_PROVIDERS: readonly ExtractorProvider[] = ["http", "naive", "cloud"];
const SKILL_GEN_PROVIDERS: readonly SkillGenProvider[] = ["auto", "anthropic-api", "claude-cli"];

function parseAnalysis(raw: unknown): AnalysisConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`analysis` must be a JSON object");
  }
  const analysis: AnalysisConfig = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      throw new ConfigError("`analysis.enabled` must be a boolean");
    }
    analysis.enabled = raw.enabled;
  }
  if (raw.chatSource !== undefined) {
    if (!CHAT_SOURCES.includes(raw.chatSource as ChatSourceKind)) {
      throw new ConfigError(`\`analysis.chatSource\` must be one of ${CHAT_SOURCES.join("|")}`);
    }
    analysis.chatSource = raw.chatSource as ChatSourceKind;
  }
  if (raw.extractor !== undefined) {
    analysis.extractor = parseExtractor(raw.extractor);
  }
  if (raw.cadence !== undefined) {
    analysis.cadence = parseCadence(raw.cadence);
  }
  if (raw.skillGen !== undefined) {
    analysis.skillGen = parseSkillGen(raw.skillGen);
  }
  if (raw.coverage !== undefined) {
    analysis.coverage = parseCoverage(raw.coverage);
  }
  return analysis;
}

function parseCoverage(raw: unknown): CoverageConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`analysis.coverage` must be a JSON object");
  }
  const coverage: CoverageConfig = {};
  if (raw.minScore !== undefined) {
    if (typeof raw.minScore !== "number" || Number.isNaN(raw.minScore) || raw.minScore < 0) {
      throw new ConfigError("`analysis.coverage.minScore` must be a non-negative number");
    }
    coverage.minScore = raw.minScore;
  }
  if (raw.relativeRatio !== undefined) {
    const r = raw.relativeRatio;
    if (typeof r !== "number" || Number.isNaN(r) || r < 0 || r > 1) {
      throw new ConfigError("`analysis.coverage.relativeRatio` must be between 0 and 1");
    }
    coverage.relativeRatio = r;
  }
  if (raw.maxSkills !== undefined) {
    const n = raw.maxSkills;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new ConfigError("`analysis.coverage.maxSkills` must be a positive integer");
    }
    coverage.maxSkills = n;
  }
  return coverage;
}

function parseExtractor(raw: unknown): ExtractorConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`analysis.extractor` must be a JSON object");
  }
  const extractor: ExtractorConfig = {};
  if (raw.provider !== undefined) {
    if (!EXTRACTOR_PROVIDERS.includes(raw.provider as ExtractorProvider)) {
      throw new ConfigError(
        `\`analysis.extractor.provider\` must be one of ${EXTRACTOR_PROVIDERS.join("|")}`,
      );
    }
    extractor.provider = raw.provider as ExtractorProvider;
  }
  for (const field of ["endpoint", "apiKey", "model"] as const) {
    if (raw[field] !== undefined) {
      if (typeof raw[field] !== "string") {
        throw new ConfigError(`\`analysis.extractor.${field}\` must be a string`);
      }
      extractor[field] = raw[field] as string;
    }
  }
  return extractor;
}

function parseCadence(raw: unknown): CadenceConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`analysis.cadence` must be a JSON object");
  }
  const cadence: CadenceConfig = {};
  if (raw.auto !== undefined) {
    if (typeof raw.auto !== "boolean") {
      throw new ConfigError("`analysis.cadence.auto` must be a boolean");
    }
    cadence.auto = raw.auto;
  }
  if (raw.everyNMessages !== undefined) {
    const n = raw.everyNMessages;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new ConfigError("`analysis.cadence.everyNMessages` must be a positive integer");
    }
    cadence.everyNMessages = n;
  }
  if (raw.onIdle !== undefined) {
    if (typeof raw.onIdle !== "boolean") {
      throw new ConfigError("`analysis.cadence.onIdle` must be a boolean");
    }
    cadence.onIdle = raw.onIdle;
  }
  if (raw.recentHours !== undefined) {
    const h = raw.recentHours;
    if (typeof h !== "number" || Number.isNaN(h) || h <= 0) {
      throw new ConfigError("`analysis.cadence.recentHours` must be a positive number");
    }
    cadence.recentHours = h;
  }
  return cadence;
}

function parseSkillGen(raw: unknown): SkillGenConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`analysis.skillGen` must be a JSON object");
  }
  const skillGen: SkillGenConfig = {};
  if (raw.provider !== undefined) {
    if (!SKILL_GEN_PROVIDERS.includes(raw.provider as SkillGenProvider)) {
      throw new ConfigError(
        `\`analysis.skillGen.provider\` must be one of ${SKILL_GEN_PROVIDERS.join("|")}`,
      );
    }
    skillGen.provider = raw.provider as SkillGenProvider;
  }
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string") {
      throw new ConfigError("`analysis.skillGen.apiKey` must be a string");
    }
    skillGen.apiKey = raw.apiKey;
  }
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") {
      throw new ConfigError("`analysis.skillGen.model` must be a string");
    }
    skillGen.model = raw.model;
  }
  return skillGen;
}

function parseSkills(raw: unknown): SkillsConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`skills` must be a JSON object");
  }
  const skills: SkillsConfig = {};
  if (raw.dirs !== undefined) {
    if (!Array.isArray(raw.dirs) || raw.dirs.some((d) => typeof d !== "string")) {
      throw new ConfigError("`skills.dirs` must be an array of strings");
    }
    skills.dirs = raw.dirs as string[];
  }
  return skills;
}

function parseEntry(path: string, raw: unknown): ServerEntry {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "stdio";

  validateDescription(path, obj);
  switch (type) {
    case "stdio":
      return parseStdio(path, obj);
    case "http":
    case "sse":
      return parseHttpLike(path, obj, type);
    default:
      // Unknown transport type — keep the entry verbatim so runtime can
      // skip-with-warn. No further validation, since we can't predict the shape.
      return { ...obj, type };
  }
}

function validateDescription(path: string, obj: Record<string, unknown>): void {
  if (obj.description !== undefined && typeof obj.description !== "string") {
    throw new ConfigError(`${path}.description must be a string`);
  }
}

function parseStdio(path: string, obj: Record<string, unknown>): ServerEntry {
  for (const field of HTTP_ONLY_FIELDS) {
    if (obj[field] !== undefined) {
      throw new ConfigError(`${path}.${field} is only valid on http/sse entries`);
    }
  }
  if (typeof obj.command !== "string" || obj.command.length === 0) {
    throw new ConfigError(`${path}.command must be a non-empty string`);
  }
  const entry: ServerEntry = { ...obj, type: "stdio", command: obj.command };
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || obj.args.some((a) => typeof a !== "string")) {
      throw new ConfigError(`${path}.args must be an array of strings`);
    }
    entry.args = obj.args as string[];
  }
  if (obj.env !== undefined) {
    if (!isPlainObject(obj.env)) {
      throw new ConfigError(`${path}.env must be an object of string values`);
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ConfigError(`${path}.env.${k} must be a string`);
      }
      env[k] = v;
    }
    entry.env = env;
  }
  if (obj.cwd !== undefined) {
    if (typeof obj.cwd !== "string") {
      throw new ConfigError(`${path}.cwd must be a string`);
    }
    entry.cwd = obj.cwd;
  }
  return entry;
}

function parseHttpLike(
  path: string,
  obj: Record<string, unknown>,
  type: "http" | "sse",
): ServerEntry {
  if (typeof obj.url !== "string" || obj.url.length === 0) {
    throw new ConfigError(`${path}.url must be a non-empty string`);
  }
  const entry: ServerEntry = { ...obj, type, url: obj.url };
  if (obj.headers !== undefined) {
    if (!isPlainObject(obj.headers)) {
      throw new ConfigError(`${path}.headers must be an object of string values`);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new ConfigError(`${path}.headers.${k} must be a string`);
      }
      headers[k] = v;
    }
    entry.headers = headers;
  }
  if (obj.clientId !== undefined) {
    if (typeof obj.clientId !== "string" || obj.clientId.length === 0) {
      throw new ConfigError(`${path}.clientId must be a non-empty string`);
    }
    entry.clientId = obj.clientId;
  }
  if (obj.clientSecret !== undefined) {
    if (typeof obj.clientSecret !== "string" || obj.clientSecret.length === 0) {
      throw new ConfigError(`${path}.clientSecret must be a non-empty string`);
    }
    entry.clientSecret = obj.clientSecret;
  }
  if (obj.callbackPort !== undefined) {
    if (typeof obj.callbackPort !== "number") {
      throw new ConfigError(`${path}.callbackPort must be a number`);
    }
    if (!Number.isInteger(obj.callbackPort)) {
      throw new ConfigError(`${path}.callbackPort must be an integer`);
    }
    if (obj.callbackPort < 0 || obj.callbackPort > 65535) {
      throw new ConfigError(`${path}.callbackPort must be between 0 and 65535`);
    }
    entry.callbackPort = obj.callbackPort;
  }
  if (obj.scope !== undefined) {
    if (typeof obj.scope !== "string") {
      throw new ConfigError(`${path}.scope must be a string`);
    }
    entry.scope = obj.scope;
  }
  return entry;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function mergeConfigs(configs: readonly RatelConfig[]): RatelConfig {
  const out: Record<string, ServerEntry> = {};
  let skills: SkillsConfig | undefined;
  let analysis: AnalysisConfig | undefined;
  for (const c of configs) {
    for (const [name, entry] of Object.entries(c.mcpServers)) {
      out[name] = entry;
    }
    if (c.skills) skills = c.skills;
    if (c.analysis) analysis = c.analysis;
  }
  const merged: RatelConfig = { mcpServers: out };
  if (skills) merged.skills = skills;
  if (analysis) merged.analysis = analysis;
  return merged;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
