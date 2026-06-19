import type { AnalysisConfig, ExtractorConfig } from "../config.js";
import type {
  AIServiceDescription,
  ChatTurn,
  Claim,
  ClaimSubtype,
  ExtractionResult,
  Intent,
  IntentExtractor,
} from "./types.js";

const CLAIM_SUBTYPES: readonly ClaimSubtype[] = [
  "factoid",
  "capability",
  "user_assertion",
  "unverifiable",
];

/** Injection seam so tests can supply a fake `fetch`. */
export interface HttpExtractorDeps {
  fetch?: typeof fetch;
  /** Abort a single extract after this many ms so a hung/crashed sidecar can't
   *  stall the whole run forever (default 5 min). */
  timeoutMs?: number;
}

const DEFAULT_EXTRACT_TIMEOUT_MS = 300_000;

/**
 * Talks to an extractor HTTP service over a single JSON contract:
 *
 *   POST {endpoint}/v1/extract
 *   { model?, messages: [{ role, content }], service_description? }
 *   → { claims: Claim[], intents: Intent[] }
 *
 * The same client serves every deployment: a local Apple-Silicon sidecar, a
 * Docker+GPU box, or a remote/cloud endpoint — only the URL (and optional
 * apiKey) differ. Responses are normalized defensively; the model may omit
 * `evidences` and can return partially-shaped rows.
 */
export class HttpIntentExtractor implements IntentExtractor {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ExtractorConfig, deps: HttpExtractorDeps = {}) {
    if (!config.endpoint) {
      throw new Error("HttpIntentExtractor requires an `endpoint`");
    }
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_EXTRACT_TIMEOUT_MS;
  }

  async extract(
    turns: ChatTurn[],
    serviceDescription?: AIServiceDescription,
  ): Promise<ExtractionResult> {
    const headers = new Headers({ "Content-Type": "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);

    const body: Record<string, unknown> = {
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    };
    if (this.model) body.model = this.model;
    if (serviceDescription) body.service_description = serviceDescription;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.endpoint}/v1/extract`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`intent extractor timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }
    if (!res.ok) {
      throw new Error(`intent extractor returned ${res.status} ${res.statusText}`);
    }
    const payload = (await res.json()) as unknown;
    return normalizeResult(payload);
  }
}

/**
 * Model-free fallback: treats each non-empty user turn as a candidate intent and
 * emits no claims. Deterministic and dependency-light — used for development,
 * tests, and when no extractor endpoint is configured.
 */
export class NaiveIntentExtractor implements IntentExtractor {
  async extract(turns: ChatTurn[]): Promise<ExtractionResult> {
    const intents: Intent[] = turns
      .filter((t) => t.role === "user")
      .map((t) => t.content.trim())
      .filter((c) => c.length > 0)
      .map((content) => ({ content }));
    return { claims: [], intents };
  }
}

/** Select the extractor implementation from the `analysis` config block. */
export function createExtractor(
  analysis: AnalysisConfig | undefined,
  deps: HttpExtractorDeps = {},
): IntentExtractor {
  const extractor = analysis?.extractor ?? {};
  const provider = extractor.provider ?? (extractor.endpoint ? "http" : "naive");
  if (provider === "naive") return new NaiveIntentExtractor();
  // "http" and "cloud" share the same HTTP client; cloud is just a remote endpoint.
  return new HttpIntentExtractor(extractor, deps);
}

function normalizeResult(payload: unknown): ExtractionResult {
  if (typeof payload !== "object" || payload === null) {
    return { claims: [], intents: [] };
  }
  const obj = payload as Record<string, unknown>;
  return {
    claims: Array.isArray(obj.claims) ? obj.claims.map(normalizeClaim).filter(isPresent) : [],
    intents: Array.isArray(obj.intents) ? obj.intents.map(normalizeIntent).filter(isPresent) : [],
  };
}

function normalizeClaim(raw: unknown): Claim | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const subtype = obj.subtype;
  const content = obj.content;
  if (typeof content !== "string" || content.trim().length === 0) return undefined;
  if (!CLAIM_SUBTYPES.includes(subtype as ClaimSubtype)) return undefined;
  const claim: Claim = { subtype: subtype as ClaimSubtype, content };
  const evidences = normalizeEvidences(obj.evidences);
  if (evidences) claim.evidences = evidences;
  return claim;
}

function normalizeIntent(raw: unknown): Intent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const content = obj.content;
  if (typeof content !== "string" || content.trim().length === 0) return undefined;
  const intent: Intent = { content };
  const evidences = normalizeEvidences(obj.evidences);
  if (evidences) intent.evidences = evidences;
  return intent;
}

function normalizeEvidences(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const evidences = raw.filter((e): e is string => typeof e === "string" && e.length > 0);
  return evidences.length > 0 ? evidences : undefined;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
