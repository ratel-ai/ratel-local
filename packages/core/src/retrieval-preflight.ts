import { join } from "node:path";
import { type EmbeddingSpec, ToolCatalog } from "@ratel-ai/sdk";
import type { RetrievalConfig } from "./lib/config.js";

export const BUILT_IN_RETRIEVAL_MODEL = "BAAI/bge-small-en-v1.5";
export const BUILT_IN_RETRIEVAL_RUNTIME_MEMORY_MB = 130;

export type RetrievalPreflightSource =
  | "none"
  | "built-in"
  | "huggingface"
  | "local"
  | "ollama"
  | "endpoint";

export interface RetrievalPreflightResult {
  status: "ready" | "not-required";
  method: RetrievalConfig["method"];
  source: RetrievalPreflightSource;
  model?: string;
  downloadedIfMissing: boolean;
  runtimeMemoryMb: number | null;
  remoteDataTransfer: boolean;
  reconnectRequired: boolean;
  message: string;
}

export type RetrievalProbe = (retrieval: RetrievalConfig) => Promise<void>;

export interface RetrievalPreflightOptions {
  homeDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  probe?: RetrievalProbe;
}

export class RetrievalPreflightError extends Error {
  readonly code = "RETRIEVAL_PREFLIGHT_FAILED";

  constructor(
    readonly reason: "missing_api_key_env" | "probe_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RetrievalPreflightError";
  }
}

export async function preflightRetrieval(
  retrieval: RetrievalConfig,
  options: RetrievalPreflightOptions,
): Promise<RetrievalPreflightResult> {
  if (retrieval.method === "bm25") {
    return {
      status: "not-required",
      method: retrieval.method,
      source: "none",
      downloadedIfMissing: false,
      runtimeMemoryMb: null,
      remoteDataTransfer: false,
      reconnectRequired: false,
      message: "BM25 is model-free; no model download or embedding service is required.",
    };
  }

  const source = describeSource(retrieval.embedding);
  const env = options.env ?? process.env;
  if (
    source.source === "endpoint" &&
    source.apiKeyEnv &&
    !nonEmptyEnvironmentValue(env[source.apiKeyEnv])
  ) {
    throw new RetrievalPreflightError(
      "missing_api_key_env",
      `embedding endpoint requires environment variable ${source.apiKeyEnv}`,
    );
  }

  const preparedRetrieval: RetrievalConfig = {
    method: retrieval.method,
    embedding: prepareEmbedding(retrieval.embedding, options.homeDir),
  };
  try {
    await (options.probe ?? defaultRetrievalProbe)(preparedRetrieval);
  } catch (error) {
    if (error instanceof RetrievalPreflightError) throw error;
    throw new RetrievalPreflightError(
      "probe_failed",
      `embedding preflight failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  return {
    status: "ready",
    method: retrieval.method,
    source: source.source,
    model: source.model,
    downloadedIfMissing: source.source === "built-in" || source.source === "huggingface",
    runtimeMemoryMb: source.source === "built-in" ? BUILT_IN_RETRIEVAL_RUNTIME_MEMORY_MB : null,
    remoteDataTransfer: source.source === "endpoint",
    reconnectRequired: true,
    message: preflightMessage(source.source, source.model),
  };
}

function prepareEmbedding(
  embedding: EmbeddingSpec | undefined,
  homeDir: string,
): EmbeddingSpec | undefined {
  if (embedding === undefined) return undefined;
  if (typeof embedding === "string") return expandHomePath(embedding, homeDir);
  if (typeof embedding.huggingface === "string") {
    return { ...embedding, huggingface: embedding.huggingface, download: true };
  }
  if (typeof embedding.local === "string") {
    return { ...embedding, local: expandHomePath(embedding.local, homeDir) };
  }
  return { ...embedding };
}

function describeSource(embedding: EmbeddingSpec | undefined): {
  source: Exclude<RetrievalPreflightSource, "none">;
  model: string;
  apiKeyEnv?: string;
} {
  if (embedding === undefined) {
    return { source: "built-in", model: BUILT_IN_RETRIEVAL_MODEL };
  }
  if (typeof embedding === "string") return { source: "local", model: embedding };
  if (typeof embedding.huggingface === "string") {
    return { source: "huggingface", model: embedding.huggingface };
  }
  if (typeof embedding.local === "string") return { source: "local", model: embedding.local };
  if (typeof embedding.ollama === "string") return { source: "ollama", model: embedding.ollama };
  return {
    source: "endpoint",
    model: embedding.model as string,
    ...(embedding.apiKeyEnv ? { apiKeyEnv: embedding.apiKeyEnv } : {}),
  };
}

async function defaultRetrievalProbe(retrieval: RetrievalConfig): Promise<void> {
  const catalog = new ToolCatalog({
    method: retrieval.method,
    ...(retrieval.embedding !== undefined ? { embedding: retrieval.embedding } : {}),
  });
  await catalog.register({
    id: "ratel_retrieval_preflight",
    name: "ratel_retrieval_preflight",
    description: "Verify that the configured embedding model can index a representative tool.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
    execute: () => ({ ok: true }),
  });
}

function expandHomePath(path: string, homeDir: string): string {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return join(homeDir, path.slice(2));
  return path;
}

function nonEmptyEnvironmentValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function preflightMessage(
  source: Exclude<RetrievalPreflightSource, "none">,
  model: string,
): string {
  if (source === "built-in" || source === "huggingface") {
    return `${model} is available in the Hugging Face cache and passed an embedding probe.`;
  }
  if (source === "local") return `${model} loaded and passed an embedding probe.`;
  if (source === "ollama") return `Ollama model ${model} responded to an embedding probe.`;
  return `Embedding endpoint model ${model} responded to an embedding probe.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
