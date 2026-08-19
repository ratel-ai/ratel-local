import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadFileToCacheDir, pathsInfo } from "@huggingface/hub";
import { type EmbeddingSpec, ToolCatalog } from "@ratel-ai/sdk";
import type { RetrievalConfig } from "./lib/config.js";

export const BUILT_IN_RETRIEVAL_MODEL = "BAAI/bge-small-en-v1.5";
export const BUILT_IN_RETRIEVAL_MODEL_REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";
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

export interface RetrievalPreparationProgress {
  phase: "downloading" | "verifying";
  file?: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

export type RetrievalPreparationProgressListener = (progress: RetrievalPreparationProgress) => void;

export interface HuggingFaceModelPreparationOptions {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  revision?: string;
  onProgress: RetrievalPreparationProgressListener;
}

export type HuggingFaceModelPreparer = (
  model: string,
  options: HuggingFaceModelPreparationOptions,
) => Promise<{ totalBytes: number }>;

export interface RetrievalPreflightOptions {
  homeDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  probe?: RetrievalProbe;
  onProgress?: RetrievalPreparationProgressListener;
  isModelCached?: (model: string, revision?: string) => Promise<boolean>;
  prepareHuggingFaceModel?: HuggingFaceModelPreparer;
}

export interface RetrievalPreparationInspection {
  action: "none" | "verify" | "download-and-verify";
  method: RetrievalConfig["method"];
  source: RetrievalPreflightSource;
  model?: string;
  runtimeMemoryMb: number | null;
  remoteDataTransfer: boolean;
}

export interface RetrievalPreparationInspectionOptions {
  homeDir: string;
  env?: Readonly<Record<string, string | undefined>>;
  isModelCached?: (model: string, revision?: string) => Promise<boolean>;
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

export async function inspectRetrievalPreparation(
  retrieval: RetrievalConfig,
  options: RetrievalPreparationInspectionOptions,
): Promise<RetrievalPreparationInspection> {
  if (retrieval.method === "bm25") {
    return {
      action: "none",
      method: retrieval.method,
      source: "none",
      runtimeMemoryMb: null,
      remoteDataTransfer: false,
    };
  }

  const source = describeSource(retrieval.embedding);
  const canDownload = source.source === "built-in" || source.source === "huggingface";
  const revision = retrievalModelRevision(source.source, retrieval.embedding);
  const isModelCached =
    options.isModelCached ??
    ((model: string, modelRevision?: string) =>
      isHuggingFaceModelCached(model, options.homeDir, options.env ?? process.env, modelRevision));
  const downloadRequired = canDownload ? !(await isModelCached(source.model, revision)) : false;

  return {
    action: downloadRequired ? "download-and-verify" : "verify",
    method: retrieval.method,
    source: source.source,
    model: source.model,
    runtimeMemoryMb: source.source === "built-in" ? BUILT_IN_RETRIEVAL_RUNTIME_MEMORY_MB : null,
    remoteDataTransfer: source.source === "endpoint",
  };
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
    let downloadedBytes = 0;
    const revision = retrievalModelRevision(source.source, retrieval.embedding);
    if (
      options.onProgress &&
      (source.source === "built-in" || source.source === "huggingface") &&
      !(await (
        options.isModelCached ??
        ((model: string, modelRevision?: string) =>
          isHuggingFaceModelCached(model, options.homeDir, env, modelRevision))
      )(source.model, revision))
    ) {
      const prepared = await (options.prepareHuggingFaceModel ?? downloadHuggingFaceRetrievalModel)(
        source.model,
        {
          homeDir: options.homeDir,
          env,
          ...(revision ? { revision } : {}),
          onProgress: options.onProgress,
        },
      );
      downloadedBytes = prepared.totalBytes;
    }
    options.onProgress?.({
      phase: "verifying",
      loadedBytes: downloadedBytes,
      totalBytes: downloadedBytes,
      percent: 100,
    });
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

const REQUIRED_HUGGING_FACE_MODEL_FILES = ["config.json", "tokenizer.json"] as const;
const HUGGING_FACE_MODEL_WEIGHT_FILES = ["model.safetensors", "pytorch_model.bin"] as const;
const OPTIONAL_HUGGING_FACE_MODEL_FILES = ["1_Pooling/config.json"] as const;

interface HuggingFaceDownloadDependencies {
  fetch?: typeof fetch;
  pathsInfo?: typeof pathsInfo;
  downloadFileToCacheDir?: typeof downloadFileToCacheDir;
}

export async function downloadHuggingFaceRetrievalModel(
  model: string,
  options: HuggingFaceModelPreparationOptions,
  dependencies: HuggingFaceDownloadDependencies = {},
): Promise<{ totalBytes: number }> {
  const getPathsInfo = dependencies.pathsInfo ?? pathsInfo;
  const cacheFile = dependencies.downloadFileToCacheDir ?? downloadFileToCacheDir;
  const baseFetch = dependencies.fetch ?? fetch;
  const repo = { type: "model" as const, name: model };
  const requestedPaths = [
    ...REQUIRED_HUGGING_FACE_MODEL_FILES,
    ...HUGGING_FACE_MODEL_WEIGHT_FILES,
    ...OPTIONAL_HUGGING_FACE_MODEL_FILES,
  ];
  const env = options.env;
  const accessToken = env.HF_TOKEN ?? env.HUGGING_FACE_HUB_TOKEN;
  const hubUrl = env.HF_ENDPOINT;
  const info = await getPathsInfo({
    repo,
    paths: requestedPaths,
    expand: true,
    ...(options.revision ? { revision: options.revision } : {}),
    ...(hubUrl ? { hubUrl } : {}),
    ...(accessToken ? { accessToken } : {}),
    fetch: baseFetch,
  });
  const infoByPath = new Map(info.map((entry) => [entry.path, entry]));
  const missing = REQUIRED_HUGGING_FACE_MODEL_FILES.filter((path) => !infoByPath.has(path));
  const hasWeights = HUGGING_FACE_MODEL_WEIGHT_FILES.some((path) => infoByPath.has(path));
  if (missing.length > 0 || !hasWeights) {
    const required = [
      ...missing,
      ...(!hasWeights ? ["model.safetensors or pytorch_model.bin"] : []),
    ];
    throw new Error(`model ${model} is missing required file(s): ${required.join(", ")}`);
  }
  const selectedWeights = HUGGING_FACE_MODEL_WEIGHT_FILES.find((path) => infoByPath.has(path));
  const downloadPaths = [
    ...REQUIRED_HUGGING_FACE_MODEL_FILES,
    ...(selectedWeights ? [selectedWeights] : []),
    ...OPTIONAL_HUGGING_FACE_MODEL_FILES,
  ];
  const files = downloadPaths.flatMap((path) => {
    const entry = infoByPath.get(path);
    return entry ? [entry] : [];
  });
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  let completedBytes = 0;

  for (const file of files) {
    let currentFileBytes = 0;
    const trackedFetch = createTrackedDownloadFetch(baseFetch, (loaded) => {
      currentFileBytes = Math.max(currentFileBytes, Math.min(file.size, loaded));
      emitDownloadProgress(
        options.onProgress,
        file.path,
        completedBytes + currentFileBytes,
        totalBytes,
      );
    });
    // The pinned Hub client forwards this download option internally. Plain HTTP exposes the
    // response bytes needed for an honest aggregate progress bar; Xet reconstruction does not.
    const params: Parameters<typeof downloadFileToCacheDir>[0] & { xet: false } = {
      repo,
      path: file.path,
      xet: false,
      cacheDir: huggingFaceCacheRoot(options.homeDir, env),
      ...(options.revision ? { revision: options.revision } : {}),
      ...(hubUrl ? { hubUrl } : {}),
      ...(accessToken ? { accessToken } : {}),
      fetch: trackedFetch,
    };
    await cacheFile(params);
    completedBytes += file.size;
    emitDownloadProgress(options.onProgress, file.path, completedBytes, totalBytes);
  }

  return { totalBytes };
}

function createTrackedDownloadFetch(
  baseFetch: typeof fetch,
  onBytes: (loaded: number) => void,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    if (method !== "GET" || headers.get("range") === "bytes=0-0" || !response.body) {
      return response;
    }

    const contentRange = response.headers.get("content-range");
    const rangeStart = contentRange ? Number(/^bytes\s+(\d+)-/i.exec(contentRange)?.[1] ?? 0) : 0;
    let responseBytes = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          responseBytes += chunk.byteLength;
          onBytes(rangeStart + responseBytes);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function emitDownloadProgress(
  listener: RetrievalPreparationProgressListener,
  file: string,
  loadedBytes: number,
  totalBytes: number,
): void {
  listener({
    phase: "downloading",
    file,
    loadedBytes,
    totalBytes,
    percent: totalBytes === 0 ? 100 : Math.min(100, (loadedBytes / totalBytes) * 100),
  });
}

function retrievalModelRevision(
  source: Exclude<RetrievalPreflightSource, "none">,
  embedding: EmbeddingSpec | undefined,
): string | undefined {
  if (source === "built-in") return BUILT_IN_RETRIEVAL_MODEL_REVISION;
  if (embedding && typeof embedding === "object" && typeof embedding.huggingface === "string") {
    return embedding.revision ?? "main";
  }
  return undefined;
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

async function isHuggingFaceModelCached(
  model: string,
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
  revision?: string,
): Promise<boolean> {
  const cacheRoot = huggingFaceCacheRoot(homeDir, env);
  const modelRoot = join(cacheRoot, `models--${model.split("/").join("--")}`);
  const snapshots = join(modelRoot, "snapshots");
  try {
    const cachedRevisions = revision
      ? await resolveCachedRevisions(modelRoot, revision)
      : await readdir(snapshots);
    for (const cachedRevision of cachedRevisions) {
      try {
        await Promise.all(
          REQUIRED_HUGGING_FACE_MODEL_FILES.map((file) =>
            stat(join(snapshots, cachedRevision, file)),
          ),
        );
        for (const weights of HUGGING_FACE_MODEL_WEIGHT_FILES) {
          try {
            await stat(join(snapshots, cachedRevision, weights));
            return true;
          } catch {
            // Try the other supported weights filename.
          }
        }
      } catch {
        // A partial or stale snapshot still needs the missing model files downloaded.
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function resolveCachedRevisions(modelRoot: string, revision: string): Promise<string[]> {
  if (/^[0-9a-f]{40}$/i.test(revision)) return [revision];
  try {
    const commit = (await readFile(join(modelRoot, "refs", revision), "utf8")).trim();
    return commit ? [commit] : [];
  } catch {
    return [];
  }
}

function huggingFaceCacheRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return (
    env.HF_HUB_CACHE ??
    env.HUGGINGFACE_HUB_CACHE ??
    env.TRANSFORMERS_CACHE ??
    (env.HF_HOME ? join(env.HF_HOME, "hub") : join(homeDir, ".cache", "huggingface", "hub"))
  );
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
