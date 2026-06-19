import { spawn as nodeSpawn } from "node:child_process";
import type { AnalysisConfig } from "../config.js";
import type { Intent, SkillDraft, SkillGenContext, SkillGenerator } from "./types.js";

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2048;
/** Bound both generators so a hung CLI/API call can't freeze the Offer dialog. */
const DEFAULT_SKILLGEN_TIMEOUT_MS = 120_000;

/**
 * Build the shared instruction that asks a Claude model to author a SKILL.md
 * draft for an uncovered intent, returned as a single JSON object.
 */
export function buildSkillPrompt(intent: Intent, context?: SkillGenContext): string {
  const existing = context?.existingSkillIds?.length
    ? `\nExisting skills (do not duplicate these): ${context.existingSkillIds.join(", ")}.`
    : "";
  return [
    "You are authoring a reusable Agent Skill for the Ratel MCP gateway.",
    `The user repeatedly tries to do this, but no skill covers it: "${intent.content}".${existing}`,
    "",
    "Make the skill SPECIFIC to this exact task. The description and tags are matched",
    "(BM25) against future requests, so use precise, distinctive wording — concrete",
    "nouns/verbs from this task — and AVOID generic filler ('the user', 'assistant',",
    "'help', 'task', 'do this') that would make it match unrelated intents.",
    "",
    "Respond with ONLY a single JSON object, no prose, no markdown fences:",
    "{",
    '  "name": "<kebab-case-id, specific to the task>",',
    '  "description": "<one sentence: what it does and exactly when to use it>",',
    '  "tags": ["<distinctive trigger phrase>", "..."],',
    '  "body": "<Markdown instructions for SKILL.md, excluding frontmatter>"',
    "}",
  ].join("\n");
}

/** Parse a model response into a validated {@link SkillDraft}, tolerating fences/prose. */
export function parseSkillDraft(text: string): SkillDraft {
  const json = extractJsonObject(text);
  if (!json) throw new Error("could not find a skill draft JSON object in the model response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("skill draft was not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("skill draft must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const name = slugify(typeof obj.name === "string" ? obj.name : "");
  const description = typeof obj.description === "string" ? obj.description.trim() : "";
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!name) throw new Error("skill draft is missing a usable name");
  if (!description) throw new Error("skill draft is missing a description");
  if (!body) throw new Error("skill draft is missing a body");
  const draft: SkillDraft = { name, description, body };
  if (Array.isArray(obj.tags)) {
    const tags = obj.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (tags.length > 0) draft.tags = tags;
  }
  return draft;
}

/** Injection seam for tests. */
export interface AnthropicDeps {
  fetch?: typeof fetch;
}

export interface AnthropicGeneratorConfig {
  apiKey?: string;
  model?: string;
}

/** Generates a skill draft via the Anthropic Messages API. */
export class AnthropicApiSkillGenerator implements SkillGenerator {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AnthropicGeneratorConfig, deps: AnthropicDeps = {}) {
    if (!config.apiKey) throw new Error("AnthropicApiSkillGenerator requires an `apiKey`");
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  async generate(intent: Intent, context?: SkillGenContext): Promise<SkillDraft> {
    const res = await this.fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: buildSkillPrompt(intent, context) }],
      }),
      signal: AbortSignal.timeout(DEFAULT_SKILLGEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Anthropic API returned ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (payload.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    return parseSkillDraft(text);
  }
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SpawnOptions {
  /** Kill the child and reject after this many ms. */
  timeoutMs?: number;
}

/** Injection seam for tests; runs a command with the prompt on stdin. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  input: string,
  opts?: SpawnOptions,
) => Promise<SpawnResult>;

export interface ClaudeCliDeps {
  spawn?: SpawnFn;
}

export interface ClaudeCliGeneratorConfig {
  /** Path to the `claude` binary (default: "claude" on PATH). */
  bin?: string;
  /** Kill the CLI after this many ms (default 2 min). */
  timeoutMs?: number;
  /** Model alias/id for `claude -p` (default "haiku" — fast; drafts are reviewed anyway). */
  model?: string;
}

/**
 * Generates a skill draft by shelling out to a local `claude -p` (print mode).
 * `--strict-mcp-config` skips loading the user's MCP servers (the Ratel gateway,
 * etc.), which otherwise boot on every call and make this slow/appear stuck.
 */
export class ClaudeCliSkillGenerator implements SkillGenerator {
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly model: string;
  private readonly spawnImpl: SpawnFn;

  constructor(config: ClaudeCliGeneratorConfig = {}, deps: ClaudeCliDeps = {}) {
    this.bin = config.bin ?? "claude";
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SKILLGEN_TIMEOUT_MS;
    this.model = config.model ?? "haiku";
    this.spawnImpl = deps.spawn ?? defaultSpawn;
  }

  async generate(intent: Intent, context?: SkillGenContext): Promise<SkillDraft> {
    const prompt = buildSkillPrompt(intent, context);
    const result = await this.spawnImpl(
      this.bin,
      ["-p", "--strict-mcp-config", "--model", this.model],
      prompt,
      { timeoutMs: this.timeoutMs },
    );
    if (result.code !== 0) {
      throw new Error(`claude -p exited with code ${result.code}: ${result.stderr.trim()}`);
    }
    return parseSkillDraft(result.stdout);
  }
}

/** Select the skill-draft generator from the `analysis` config block. */
export function createSkillGenerator(
  analysis: AnalysisConfig | undefined,
  deps: { anthropic?: AnthropicDeps; cli?: ClaudeCliDeps } = {},
): SkillGenerator {
  const skillGen = analysis?.skillGen ?? {};
  const provider = skillGen.provider ?? "auto";
  const useApi = provider === "anthropic-api" || (provider === "auto" && Boolean(skillGen.apiKey));
  if (useApi) {
    return new AnthropicApiSkillGenerator({ apiKey: skillGen.apiKey }, deps.anthropic);
  }
  return new ClaudeCliSkillGenerator({}, deps.cli);
}

function defaultSpawn(
  cmd: string,
  args: string[],
  input: string,
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // RATEL_SKIP_CAPTURE stops the nested `claude -p` (and its hooks) from
    // recording this prompt as chat — otherwise the skill-gen prompt leaks back
    // in as bogus "intents".
    const child = nodeSpawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RATEL_SKIP_CAPTURE: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
    };
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.stdin.end(input);
  });
}

/** Extract the first balanced top-level JSON object from arbitrary text. */
function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
