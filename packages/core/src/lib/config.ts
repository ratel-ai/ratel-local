import { isAbsolute } from "node:path";
import type { EmbeddingSpec, SearchMethod } from "@ratel-ai/sdk";
import { isPlainObject } from "../json.js";
import { isSafeSkillId } from "../skill-id.js";

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

export type SkillSource = "claude" | "codex" | "ratel" | "unknown";

export type SkillEntry =
  | {
      mode: "reference";
      path: string;
      source?: SkillSource;
    }
  | {
      mode: "copy";
      source?: SkillSource;
      copiedFrom?: { source: string; id: string };
    };

/** Ratel-managed skills: explicit registrations plus legacy directories. */
export interface SkillsConfig {
  entries?: Record<string, SkillEntry>;
  dirs?: string[];
}

export interface RetrievalConfig {
  method: SearchMethod;
  /**
   * Omit for the SDK's pinned built-in model. Explicit sources are validated
   * here so dense retrieval never starts with an ambiguous or unsafe model
   * selection.
   */
  embedding?: EmbeddingSpec;
}

/** Lossless on-disk shape. Mutations retain unknown top-level fields. */
export interface RatelConfigDocument {
  mcpServers?: Record<string, ServerEntry>;
  skills?: SkillsConfig;
  retrieval?: RetrievalConfig;
  [key: string]: unknown;
}

export interface RatelConfig {
  mcpServers: Record<string, ServerEntry>;
  skills?: SkillsConfig;
  retrieval?: RetrievalConfig;
}

export function parseConfig(input: unknown): RatelConfig {
  if (!isPlainObject(input)) {
    throw new ConfigError("root must be a JSON object");
  }
  const mcpServers = (input as Record<string, unknown>).mcpServers ?? {};
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
  const retrieval = (input as Record<string, unknown>).retrieval;
  if (retrieval !== undefined) {
    config.retrieval = parseRetrieval(retrieval);
  }
  return config;
}

function parseRetrieval(raw: unknown): RetrievalConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`retrieval` must be a JSON object");
  }
  assertOnlyKeys("retrieval", raw, ["method", "embedding"]);
  const method = parseRetrievalMethod(raw.method);
  if (method === "bm25" && raw.embedding !== undefined) {
    throw new ConfigError(
      "`retrieval.embedding` is inactive when `retrieval.method` is bm25; remove it or select semantic|hybrid",
    );
  }
  return {
    method,
    ...(raw.embedding !== undefined
      ? { embedding: parseEmbedding("retrieval.embedding", raw.embedding) }
      : {}),
  };
}

function parseRetrievalMethod(raw: unknown): SearchMethod {
  if (raw === "bm25" || raw === "semantic" || raw === "hybrid") return raw;
  throw new ConfigError("`retrieval.method` must be one of bm25|semantic|hybrid");
}

function parseEmbedding(path: string, raw: unknown): EmbeddingSpec {
  if (typeof raw === "string") {
    return parseLocalModelPath(path, raw);
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(`\`${path}\` must be a local model path or a JSON object`);
  }
  if ("apiKey" in raw) {
    throw new ConfigError(`\`${path}.apiKey\` is not allowed; use apiKeyEnv instead`);
  }

  const sources = ["huggingface", "local", "ollama", "url"].filter((key) => raw[key] !== undefined);
  if (sources.length !== 1) {
    throw new ConfigError(
      `\`${path}\` must select exactly one source: huggingface|local|ollama|url`,
    );
  }

  const source = sources[0];
  switch (source) {
    case "huggingface": {
      assertOnlyKeys(path, raw, [
        "huggingface",
        "revision",
        "queryPrefix",
        "docPrefix",
        "pooling",
        "download",
      ]);
      const config: Extract<EmbeddingSpec, { huggingface: string }> = {
        huggingface: nonEmptyString(`${path}.huggingface`, raw.huggingface),
      };
      const revision = optionalNonEmptyString(`${path}.revision`, raw.revision);
      const queryPrefix = optionalString(`${path}.queryPrefix`, raw.queryPrefix);
      const docPrefix = optionalString(`${path}.docPrefix`, raw.docPrefix);
      const pooling = optionalPooling(`${path}.pooling`, raw.pooling);
      const download = optionalBoolean(`${path}.download`, raw.download);
      if (revision !== undefined) config.revision = revision;
      if (queryPrefix !== undefined) config.queryPrefix = queryPrefix;
      if (docPrefix !== undefined) config.docPrefix = docPrefix;
      if (pooling !== undefined) config.pooling = pooling;
      if (download !== undefined) config.download = download;
      return config;
    }
    case "local": {
      assertOnlyKeys(path, raw, ["local", "queryPrefix", "docPrefix", "pooling"]);
      const config: Extract<EmbeddingSpec, { local: string }> = {
        local: parseLocalModelPath(`${path}.local`, raw.local),
      };
      const queryPrefix = optionalString(`${path}.queryPrefix`, raw.queryPrefix);
      const docPrefix = optionalString(`${path}.docPrefix`, raw.docPrefix);
      const pooling = optionalPooling(`${path}.pooling`, raw.pooling);
      if (queryPrefix !== undefined) config.queryPrefix = queryPrefix;
      if (docPrefix !== undefined) config.docPrefix = docPrefix;
      if (pooling !== undefined) config.pooling = pooling;
      return config;
    }
    case "ollama": {
      assertOnlyKeys(path, raw, ["ollama", "queryPrefix", "docPrefix"]);
      const config: Extract<EmbeddingSpec, { ollama: string }> = {
        ollama: nonEmptyString(`${path}.ollama`, raw.ollama),
      };
      const queryPrefix = optionalString(`${path}.queryPrefix`, raw.queryPrefix);
      const docPrefix = optionalString(`${path}.docPrefix`, raw.docPrefix);
      if (queryPrefix !== undefined) config.queryPrefix = queryPrefix;
      if (docPrefix !== undefined) config.docPrefix = docPrefix;
      return config;
    }
    case "url": {
      assertOnlyKeys(path, raw, ["url", "model", "apiKeyEnv", "queryPrefix", "docPrefix"]);
      const url = nonEmptyString(`${path}.url`, raw.url);
      validateEmbeddingEndpoint(`${path}.url`, url);
      const config: Extract<EmbeddingSpec, { url: string }> = {
        url,
        model: nonEmptyString(`${path}.model`, raw.model),
      };
      const apiKeyEnv = optionalNonEmptyString(`${path}.apiKeyEnv`, raw.apiKeyEnv);
      const queryPrefix = optionalString(`${path}.queryPrefix`, raw.queryPrefix);
      const docPrefix = optionalString(`${path}.docPrefix`, raw.docPrefix);
      if (apiKeyEnv !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
          throw new ConfigError(`\`${path}.apiKeyEnv\` must be an environment variable name`);
        }
        config.apiKeyEnv = apiKeyEnv;
      }
      if (queryPrefix !== undefined) config.queryPrefix = queryPrefix;
      if (docPrefix !== undefined) config.docPrefix = docPrefix;
      return config;
    }
    default:
      throw new ConfigError(`\`${path}\` has an unsupported source`);
  }
}

function parseLocalModelPath(path: string, raw: unknown): string {
  const value = nonEmptyString(path, raw);
  if (!(isAbsolute(value) || value === "~" || value.startsWith("~/"))) {
    throw new ConfigError(`\`${path}\` must be an absolute path or start with ~/`);
  }
  return value;
}

function validateEmbeddingEndpoint(path: string, value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`\`${path}\` must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(`\`${path}\` must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new ConfigError(`\`${path}\` must not contain credentials`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (isSecretQueryParameter(key)) {
      throw new ConfigError(
        `\`${path}\` must not contain credential query parameter \`${key}\`; use apiKeyEnv instead`,
      );
    }
  }
}

function isSecretQueryParameter(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[-_.]/g, "");
  return SECRET_QUERY_PARAMETERS.has(normalized);
}

const SECRET_QUERY_PARAMETERS = new Set([
  "apikey",
  "token",
  "accesstoken",
  "authtoken",
  "auth",
  "authorization",
  "password",
  "secret",
  "clientsecret",
]);

function assertOnlyKeys(
  path: string,
  raw: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unexpected = Object.keys(raw).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ConfigError(`\`${path}.${unexpected}\` is not supported`);
  }
}

function nonEmptyString(path: string, raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new ConfigError(`\`${path}\` must be a non-empty string`);
  }
  return raw;
}

function optionalNonEmptyString(path: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  return nonEmptyString(path, raw);
}

function optionalString(path: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") throw new ConfigError(`\`${path}\` must be a string`);
  return raw;
}

function optionalPooling(path: string, raw: unknown): "cls" | "mean" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "cls" || raw === "mean") return raw;
  throw new ConfigError(`\`${path}\` must be one of cls|mean`);
}

function optionalBoolean(path: string, raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") throw new ConfigError(`\`${path}\` must be a boolean`);
  return raw;
}

function parseSkills(raw: unknown): SkillsConfig {
  if (!isPlainObject(raw)) {
    throw new ConfigError("`skills` must be a JSON object");
  }
  const skills: SkillsConfig = {};
  if (raw.entries !== undefined) {
    if (!isPlainObject(raw.entries)) {
      throw new ConfigError("`skills.entries` must be a JSON object");
    }
    const entries: Record<string, SkillEntry> = {};
    for (const [id, entry] of Object.entries(raw.entries)) {
      if (!isSafeSkillId(id)) {
        throw new ConfigError(
          `\`skills.entries\` contains an unsafe skill id: ${JSON.stringify(id)}`,
        );
      }
      entries[id] = parseSkillEntry(`skills.entries.${id}`, entry);
    }
    skills.entries = entries;
  }
  if (raw.dirs !== undefined) {
    if (!Array.isArray(raw.dirs) || raw.dirs.some((d) => typeof d !== "string")) {
      throw new ConfigError("`skills.dirs` must be an array of strings");
    }
    skills.dirs = raw.dirs as string[];
  }
  return skills;
}

function parseSkillEntry(path: string, raw: unknown): SkillEntry {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`\`${path}\` must be a JSON object`);
  }
  const source = parseSkillSource(`${path}.source`, raw.source);
  if (raw.mode === "reference") {
    if (typeof raw.path !== "string" || raw.path.length === 0) {
      throw new ConfigError(`\`${path}.path\` must be a non-empty string`);
    }
    return { mode: "reference", path: raw.path, ...(source ? { source } : {}) };
  }
  if (raw.mode === "copy") {
    let copiedFrom: { source: string; id: string } | undefined;
    if (raw.copiedFrom !== undefined) {
      if (
        !isPlainObject(raw.copiedFrom) ||
        typeof raw.copiedFrom.source !== "string" ||
        typeof raw.copiedFrom.id !== "string" ||
        raw.copiedFrom.source.length === 0 ||
        raw.copiedFrom.id.length === 0
      ) {
        throw new ConfigError(`\`${path}.copiedFrom\` must contain string source and id`);
      }
      copiedFrom = { source: raw.copiedFrom.source, id: raw.copiedFrom.id };
    }
    return { mode: "copy", ...(source ? { source } : {}), ...(copiedFrom ? { copiedFrom } : {}) };
  }
  throw new ConfigError(`\`${path}.mode\` must be one of reference|copy`);
}

function parseSkillSource(path: string, raw: unknown): SkillSource | undefined {
  if (raw === undefined) return undefined;
  if (raw === "claude" || raw === "codex" || raw === "ratel" || raw === "unknown") return raw;
  throw new ConfigError(`\`${path}\` must be one of claude|codex|ratel|unknown`);
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

export function mergeConfigs(configs: readonly RatelConfig[]): RatelConfig {
  const out: Record<string, ServerEntry> = {};
  let skills: SkillsConfig | undefined;
  let retrieval: RetrievalConfig | undefined;
  for (const c of configs) {
    for (const [name, entry] of Object.entries(c.mcpServers)) {
      out[name] = entry;
    }
    if (c.skills) skills = c.skills;
    if (c.retrieval) retrieval = c.retrieval;
  }
  return {
    mcpServers: out,
    ...(skills ? { skills } : {}),
    ...(retrieval ? { retrieval } : {}),
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
