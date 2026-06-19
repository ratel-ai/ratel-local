import {
  type AnalysisConfig,
  type HierarchyEnv,
  type JsonFs,
  parseConfig,
  ratelConfigPath,
} from "@ratel-ai/mcp-core";

/**
 * Sentinel returned in place of a stored secret. When the UI sends it back
 * unchanged, {@link mergeAnalysisSecrets} preserves the existing value rather
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
 * Reconcile incoming settings with what is stored: a masked `apiKey` keeps the
 * existing secret, an empty `apiKey` clears it, and any other value replaces it.
 */
export function mergeAnalysisSecrets(
  incoming: AnalysisConfig,
  existing?: AnalysisConfig,
): AnalysisConfig {
  const out: AnalysisConfig = { ...incoming };
  if (incoming.extractor) out.extractor = mergeKey(incoming.extractor, existing?.extractor);
  if (incoming.skillGen) out.skillGen = mergeKey(incoming.skillGen, existing?.skillGen);
  return out;
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
  const merged = mergeAnalysisSecrets(incoming, existing);

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
