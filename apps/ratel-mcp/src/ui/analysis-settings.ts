import {
  type AnalysisConfig,
  type HierarchyEnv,
  type JsonFs,
  parseConfig,
  ratelConfigPath,
} from "@ratel-ai/mcp-core";

/**
 * Sentinel returned in place of a stored secret. When the UI sends it back
 * unchanged, {@link mergeAnalysisConfig} preserves the existing value rather
 * than overwriting the real key with the mask.
 */
export const SECRET_MASK = "__RATEL_SECRET_KEPT__";

type WithApiKey = { apiKey?: string };

/** Replace any present `apiKey` with {@link SECRET_MASK} so secrets never leave the server. */
export function maskAnalysis(analysis?: AnalysisConfig): AnalysisConfig {
  if (!analysis) return {};
  const out: AnalysisConfig = { ...analysis };
  if (analysis.extractor) out.extractor = maskKey(analysis.extractor);
  if (analysis.skillGen) out.skillGen = maskKey(analysis.skillGen);
  return out;
}

/**
 * Reconcile incoming settings with what is stored, field by field, so a partial
 * save never discards values it didn't send:
 *
 *  - Nested sections (extractor/cadence/skillGen/coverage) merge key by key: keys
 *    present in `incoming` win, keys it omits are kept from `existing`. This is
 *    what stops a Settings form carrying only `{ provider: "http" }` from wiping a
 *    previously-stored `endpoint`/`model` (and likewise for cadence/skillGen).
 *  - Secrets keep their special handling: a masked `apiKey` preserves the stored
 *    secret, an empty `apiKey` clears it, and any other value replaces it.
 *
 * Trade-off: because omitted keys are preserved, a section value can be changed
 * but not unset through this path — acceptable since each field has a runtime
 * default and the form always reflects the current value.
 */
export function mergeAnalysisConfig(
  incoming: AnalysisConfig,
  existing?: AnalysisConfig,
): AnalysisConfig {
  const base = existing ?? {};
  const out: AnalysisConfig = { ...base, ...incoming };

  const extractor = mergeSection(base.extractor, incoming.extractor);
  if (extractor) out.extractor = mergeKey(extractor, base.extractor);
  const skillGen = mergeSection(base.skillGen, incoming.skillGen);
  if (skillGen) out.skillGen = mergeKey(skillGen, base.skillGen);

  const cadence = mergeSection(base.cadence, incoming.cadence);
  if (cadence) out.cadence = cadence;
  const coverage = mergeSection(base.coverage, incoming.coverage);
  if (coverage) out.coverage = coverage;

  return out;
}

/** Field-level merge of one nested section: incoming keys win, omitted keys kept. */
function mergeSection<T extends object>(
  existing: T | undefined,
  incoming: T | undefined,
): T | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  return { ...existing, ...incoming };
}

function maskKey<T extends WithApiKey>(value: T): T {
  return value.apiKey ? { ...value, apiKey: SECRET_MASK } : value;
}

function mergeKey<T extends WithApiKey>(incoming: T, existing?: T): T {
  if (incoming.apiKey === undefined) return incoming;
  if (incoming.apiKey === SECRET_MASK) {
    const out = { ...incoming };
    if (existing?.apiKey) out.apiKey = existing.apiKey;
    else delete (out as WithApiKey).apiKey;
    return out;
  }
  if (incoming.apiKey === "") {
    const out = { ...incoming };
    delete (out as WithApiKey).apiKey;
    return out;
  }
  return incoming;
}

/** Read the user-scope `analysis` block with secrets masked for transport. */
export async function readAnalysisSettings(env: HierarchyEnv, fs: JsonFs): Promise<AnalysisConfig> {
  return maskAnalysis(await readRawAnalysis(env, fs));
}

/**
 * Validate + persist the `analysis` block into the user-scope config, preserving
 * every other top-level key, and return the saved settings with secrets masked.
 * Throws on an invalid block (callers map to HTTP 400).
 */
export async function writeAnalysisSettings(
  env: HierarchyEnv,
  fs: JsonFs,
  incoming: AnalysisConfig,
): Promise<AnalysisConfig> {
  const path = ratelConfigPath("user", env);
  const current = await readRawConfig(fs, path);
  const existing = current.analysis as AnalysisConfig | undefined;
  const merged = mergeAnalysisConfig(incoming, existing);

  // Validate types/enums via the canonical parser (throws ConfigError on bad input).
  parseConfig({ mcpServers: {}, analysis: merged });

  const next: Record<string, unknown> = { ...current, analysis: merged };
  if (!next.mcpServers) next.mcpServers = {};
  await fs.writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return maskAnalysis(merged);
}

async function readRawAnalysis(env: HierarchyEnv, fs: JsonFs): Promise<AnalysisConfig | undefined> {
  const current = await readRawConfig(fs, ratelConfigPath("user", env));
  return current.analysis as AnalysisConfig | undefined;
}

async function readRawConfig(fs: JsonFs, path: string): Promise<Record<string, unknown>> {
  const raw = await fs.read(path);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
