import {
  documentRevision,
  loadMergedConfig,
  parseConfig,
  type RatelScope,
  type RetrievalConfig,
  type RetrievalPreflightOptions,
  type RetrievalPreflightResult,
  ratelConfigPath,
  readJson,
  resolveScope,
} from "@ratel-ai/ratel-local-core";
import type { EmbeddingSpec } from "@ratel-ai/sdk";
import { ArgError } from "../args.js";
import type { HandlerCtx } from "./types.js";

export const RETRIEVAL_USAGE = `usage: ratel-local retrieval <verb> [flags]

Verbs:
  status      show user/project/local overrides and the effective retrieval mode
  configure   write one atomic retrieval override
  reset       remove one scoped override and inherit the earlier scope
  prepare     download/verify a model or check Ollama/endpoint availability

Scopes:
  --scope user|project|local   selected write/preflight scope (writes default to user)

Configure:
  --method bm25|semantic|hybrid
  --source built-in|huggingface|local|ollama|endpoint
  --model <id-or-path>         required except for built-in
  --url <embeddings-url>       required for endpoint
  --api-key-env <ENV_NAME>     endpoint bearer key environment variable
  --revision <git-revision>    optional Hugging Face revision
  --download / --no-download   Hugging Face startup download policy
  --query-prefix <text>        optional query prefix
  --doc-prefix <text>          optional document prefix
  --pooling cls|mean           optional local/Hugging Face pooling`;

export interface CliRetrievalMutationRequest {
  action: "configure" | "reset";
  scope: RatelScope;
  retrieval?: RetrievalConfig;
  expectedRevision?: ReturnType<typeof documentRevision>;
}

export type CliRetrievalMutator = (
  request: CliRetrievalMutationRequest,
) => Promise<{ path: string }>;

export interface RetrievalHandlerDependencies {
  mutateRetrieval?: CliRetrievalMutator;
  preflight?: (
    retrieval: RetrievalConfig,
    options: RetrievalPreflightOptions,
  ) => Promise<RetrievalPreflightResult>;
}

export async function runRetrieval(
  ctx: HandlerCtx,
  dependencies: RetrievalHandlerDependencies = {},
): Promise<void> {
  switch (ctx.argv.verb) {
    case "status":
      await showStatus(ctx);
      return;
    case "configure":
      await configureRetrieval(ctx, dependencies);
      return;
    case "reset":
      await resetRetrieval(ctx, dependencies);
      return;
    case "prepare":
      await prepareRetrieval(ctx, dependencies);
      return;
    default:
      throw new ArgError(`unknown retrieval verb: ${ctx.argv.verb}`);
  }
}

async function showStatus(ctx: HandlerCtx): Promise<void> {
  const scopes: RatelScope[] = ["user", "project", "local"];
  for (const scope of scopes) {
    const retrieval = await readScopedRetrieval(ctx, scope);
    ctx.log(
      `${scope.padEnd(9)}${retrieval ? `${retrieval.method.padEnd(10)}${sourceLabel(retrieval)}` : "inherited"}`,
    );
  }
  const effective = (await loadMergedConfig(ctx))?.retrieval ?? { method: "bm25" as const };
  ctx.log(`effective ${effective.method.padEnd(10)}${sourceLabel(effective)}`);
  logLifecycleDisclosure(ctx, effective);
}

async function configureRetrieval(
  ctx: HandlerCtx,
  dependencies: RetrievalHandlerDependencies,
): Promise<void> {
  if (!dependencies.mutateRetrieval) {
    throw new Error("retrieval mutation control plane is unavailable");
  }
  const scope = resolveScope(ctx.argv.flags.scope);
  const retrieval = configuredRetrieval(ctx);
  const expectedRevision = await scopedRevision(ctx, scope);
  const result = await dependencies.mutateRetrieval({
    action: "configure",
    scope,
    retrieval,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  ctx.log(`configured ${scope} retrieval at ${result.path}`);
  logLifecycleDisclosure(ctx, retrieval);
}

async function resetRetrieval(
  ctx: HandlerCtx,
  dependencies: RetrievalHandlerDependencies,
): Promise<void> {
  if (!dependencies.mutateRetrieval) {
    throw new Error("retrieval mutation control plane is unavailable");
  }
  const scope = resolveScope(ctx.argv.flags.scope);
  const expectedRevision = await scopedRevision(ctx, scope);
  const result = await dependencies.mutateRetrieval({
    action: "reset",
    scope,
    ...(expectedRevision ? { expectedRevision } : {}),
  });
  ctx.log(`reset ${scope} retrieval override at ${result.path}`);
  ctx.log(
    "Reconnect the affected agent/context to acquire the inherited retrieval generation; restart the daemon only if reconnecting is unavailable.",
  );
}

async function prepareRetrieval(
  ctx: HandlerCtx,
  dependencies: RetrievalHandlerDependencies,
): Promise<void> {
  if (!dependencies.preflight) throw new Error("retrieval preflight is unavailable");
  const scopeFlag = ctx.argv.flags.scope;
  const retrieval =
    scopeFlag === undefined
      ? ((await loadMergedConfig(ctx))?.retrieval ?? { method: "bm25" as const })
      : ((await readScopedRetrieval(ctx, resolveScope(scopeFlag))) ?? {
          method: "bm25" as const,
        });
  const result = await dependencies.preflight(retrieval, { homeDir: ctx.env.homeDir });
  ctx.log(result.message);
  if (result.runtimeMemoryMb !== null) {
    ctx.log(
      `The loaded in-process model uses approximately ~${result.runtimeMemoryMb} MB of process memory and is shared by tool and skill catalogs.`,
    );
  }
  ctx.log(
    result.remoteDataTransfer
      ? "Tool/skill metadata and retrieval queries are sent to the configured embedding endpoint."
      : "Embedding metadata and queries stay local to this machine.",
  );
  if (result.source === "built-in") {
    ctx.log(
      "The pinned BAAI/bge-small-en-v1.5 model uses the Hugging Face cache and is English-focused; choose a multilingual Hugging Face model when needed.",
    );
  } else if (result.source === "huggingface") {
    ctx.log("The prepared model uses the Hugging Face cache.");
  }
  ctx.log("Local retrieval traces remain under ~/.ratel/telemetry.");
  if (result.reconnectRequired) {
    ctx.log(
      "Reconnect the affected agent/context to acquire the prepared retrieval generation; restart the daemon only as a fallback.",
    );
  }
}

function configuredRetrieval(ctx: HandlerCtx): RetrievalConfig {
  const method = requiredFlag(ctx, "method");
  if (method !== "bm25" && method !== "semantic" && method !== "hybrid") {
    throw new ArgError("--method must be one of bm25|semantic|hybrid");
  }
  const source = optionalFlag(ctx, "source");
  if (method === "bm25") {
    if (source !== undefined || unsupportedEmbeddingFlag(ctx, [])) {
      throw new ArgError("BM25 is model-free; remove embedding source/model flags");
    }
    return { method };
  }

  const embedding = embeddingFromFlags(ctx, source ?? "built-in");
  return parseConfig({
    mcpServers: {},
    retrieval: {
      method,
      ...(embedding !== undefined ? { embedding } : {}),
    },
  }).retrieval as RetrievalConfig;
}

function embeddingFromFlags(ctx: HandlerCtx, source: string): EmbeddingSpec | undefined {
  const queryPrefix = optionalFlag(ctx, "query-prefix");
  const docPrefix = optionalFlag(ctx, "doc-prefix");
  const prefixes = {
    ...(queryPrefix !== undefined ? { queryPrefix } : {}),
    ...(docPrefix !== undefined ? { docPrefix } : {}),
  };
  if (source === "built-in") {
    if (unsupportedEmbeddingFlag(ctx, [])) {
      throw new ArgError("built-in source does not accept model, URL, revision, or pooling flags");
    }
    return undefined;
  }
  if (source === "huggingface") {
    assertEmbeddingFlagsForSource(ctx, source, [
      "model",
      "revision",
      "download",
      "query-prefix",
      "doc-prefix",
      "pooling",
    ]);
    const pooling = optionalPooling(ctx);
    const revision = optionalFlag(ctx, "revision");
    const download = optionalBooleanFlag(ctx, "download");
    return {
      huggingface: requiredFlag(ctx, "model"),
      ...prefixes,
      ...(revision !== undefined ? { revision } : {}),
      ...(pooling !== undefined ? { pooling } : {}),
      ...(download !== undefined ? { download } : {}),
    };
  }
  if (source === "local") {
    assertEmbeddingFlagsForSource(ctx, source, [
      "model",
      "query-prefix",
      "doc-prefix",
      "pooling",
    ]);
    const pooling = optionalPooling(ctx);
    return {
      local: requiredFlag(ctx, "model"),
      ...prefixes,
      ...(pooling !== undefined ? { pooling } : {}),
    };
  }
  if (source === "ollama") {
    assertEmbeddingFlagsForSource(ctx, source, ["model", "query-prefix", "doc-prefix"]);
    return { ollama: requiredFlag(ctx, "model"), ...prefixes };
  }
  if (source === "endpoint") {
    assertEmbeddingFlagsForSource(ctx, source, [
      "model",
      "url",
      "api-key-env",
      "query-prefix",
      "doc-prefix",
    ]);
    const apiKeyEnv = optionalFlag(ctx, "api-key-env");
    return {
      url: requiredFlag(ctx, "url"),
      model: requiredFlag(ctx, "model"),
      ...prefixes,
      ...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
    };
  }
  throw new ArgError("--source must be one of built-in|huggingface|local|ollama|endpoint");
}

async function readScopedRetrieval(
  ctx: HandlerCtx,
  scope: RatelScope,
): Promise<RetrievalConfig | undefined> {
  let path: string;
  try {
    path = ratelConfigPath(scope, ctx.env);
  } catch {
    return undefined;
  }
  const document = await readJson<unknown>(ctx.fs, path);
  return document === null ? undefined : parseConfig(document).retrieval;
}

async function scopedRevision(
  ctx: HandlerCtx,
  scope: RatelScope,
): Promise<ReturnType<typeof documentRevision> | undefined> {
  const path = ratelConfigPath(scope, ctx.env);
  const raw = await ctx.fs.read(path);
  return raw === null ? undefined : documentRevision(Buffer.from(raw, "utf8"));
}

function sourceLabel(retrieval: RetrievalConfig): string {
  const embedding = retrieval.embedding;
  if (retrieval.method === "bm25") return "model-free";
  if (embedding === undefined) return "built-in";
  if (typeof embedding === "string") return `local:${embedding}`;
  if (typeof embedding.huggingface === "string") return `huggingface:${embedding.huggingface}`;
  if (typeof embedding.local === "string") return `local:${embedding.local}`;
  if (typeof embedding.ollama === "string") return `ollama:${embedding.ollama}`;
  return `endpoint:${embedding.model}`;
}

function logLifecycleDisclosure(ctx: HandlerCtx, retrieval: RetrievalConfig): void {
  if (retrieval.method === "bm25") {
    ctx.log("BM25 is model-free and performs no embedding downloads or requests.");
    return;
  }
  const embedding = retrieval.embedding;
  if (embedding === undefined) {
    ctx.log(
      "The pinned BAAI/bge-small-en-v1.5 model uses the Hugging Face cache, adds roughly 130 MB while loaded, and is English-focused; choose a multilingual Hugging Face model when needed.",
    );
  } else if (typeof embedding === "string" || typeof embedding.local === "string") {
    ctx.log(
      "The local in-process model keeps metadata and queries on this machine; memory varies.",
    );
  } else if (typeof embedding.huggingface === "string") {
    ctx.log(
      "The in-process model uses the Hugging Face cache; memory and multilingual coverage vary by model.",
    );
  } else if (typeof embedding.ollama === "string") {
    ctx.log(
      "Tool/skill metadata and retrieval queries are sent to the configured local Ollama service.",
    );
  } else {
    ctx.log(
      "Tool/skill metadata and retrieval queries are sent to the configured embedding endpoint.",
    );
  }
  ctx.log("Local retrieval traces remain under ~/.ratel/telemetry.");
  ctx.log(
    "Dense retrieval changes apply to new gateway generations. Reconnect the affected agent/context; restart the daemon only as a fallback.",
  );
}

const EMBEDDING_FLAGS = [
  "model",
  "url",
  "api-key-env",
  "revision",
  "download",
  "query-prefix",
  "doc-prefix",
  "pooling",
] as const;

function assertEmbeddingFlagsForSource(
  ctx: HandlerCtx,
  source: string,
  allowed: readonly (typeof EMBEDDING_FLAGS)[number][],
): void {
  const unsupported = unsupportedEmbeddingFlag(ctx, allowed);
  if (unsupported) {
    throw new ArgError(`--${unsupported} is not valid with --source ${source}`);
  }
}

function unsupportedEmbeddingFlag(
  ctx: HandlerCtx,
  allowed: readonly (typeof EMBEDDING_FLAGS)[number][],
): (typeof EMBEDDING_FLAGS)[number] | undefined {
  return EMBEDDING_FLAGS.find(
    (flag) => !allowed.includes(flag) && ctx.argv.flags[flag] !== undefined,
  );
}

function requiredFlag(ctx: HandlerCtx, name: string): string {
  const value = optionalFlag(ctx, name);
  if (value === undefined || value.length === 0) throw new ArgError(`--${name} is required`);
  return value;
}

function optionalFlag(ctx: HandlerCtx, name: string): string | undefined {
  const value = ctx.argv.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ArgError(`--${name} requires one value`);
  return value;
}

function optionalBooleanFlag(ctx: HandlerCtx, name: string): boolean | undefined {
  const value = ctx.argv.flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ArgError(`--${name} does not accept a value`);
  return value;
}

function optionalPooling(ctx: HandlerCtx): "cls" | "mean" | undefined {
  const pooling = optionalFlag(ctx, "pooling");
  if (pooling === undefined) return undefined;
  if (pooling === "cls" || pooling === "mean") return pooling;
  throw new ArgError("--pooling must be cls or mean");
}
