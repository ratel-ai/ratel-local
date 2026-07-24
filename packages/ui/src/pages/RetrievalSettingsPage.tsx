import { CheckCircle2, DatabaseZap, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import { type ConfigResponse, type RatelScope, type RetrievalConfig, useRatelApp } from "@/App";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RuntimeUiContext } from "@/lib/runtime-context";

type RetrievalMethod = RetrievalConfig["method"];
type RetrievalSource = "built-in" | "huggingface" | "local" | "ollama" | "endpoint";

export interface RetrievalDraft {
  method: RetrievalMethod;
  source: RetrievalSource;
  model: string;
  url: string;
  apiKeyEnv: string;
  revision: string;
  download: boolean;
  queryPrefix: string;
  docPrefix: string;
  pooling: "" | "cls" | "mean";
}

interface RetrievalPreflightView {
  status: "ready" | "not-required";
  message: string;
  source: string;
  model?: string;
  runtimeMemoryMb: number | null;
  remoteDataTransfer: boolean;
  reconnectRequired: boolean;
}

interface RetrievalPreflightState {
  draftKey: string;
  result: RetrievalPreflightView;
}

export function RetrievalSettingsPage() {
  const { config, configError, configLoading, context } = useRatelApp();
  const scopes = availableRetrievalScopes(context);
  const [requestedScope, setRequestedScope] = useState<RatelScope>(scopes[0] ?? "user");
  const scope = scopes.includes(requestedScope) ? requestedScope : (scopes[0] ?? "user");
  const scopeState = config?.scopes[scope];
  const override = scopeState?.available ? scopeState.config.retrieval : undefined;
  const revision = documentRevisionForScope(config, scope);
  const editorKey = `${scope}:${revision ?? "missing"}:${JSON.stringify(override ?? null)}`;
  const effective = effectiveRetrieval(config);

  return (
    <main className="grid w-full gap-6">
      <header className="grid gap-2">
        <div className="flex items-center gap-2 text-ctx-skills">
          <DatabaseZap className="size-5" />
          <span className="font-mono text-xs uppercase tracking-[0.18em]">Retrieval</span>
        </div>
        <h1 className="font-semibold text-3xl tracking-tight">Retrieval settings</h1>
        <p className="max-w-3xl text-muted-foreground">
          Keep BM25 model-free, or opt this runtime context into semantic or hybrid retrieval. Each
          scope replaces the complete earlier retrieval block.
        </p>
      </header>

      {configError ? (
        <Alert variant="destructive">
          <AlertTitle>Configuration unavailable</AlertTitle>
          <AlertDescription>{configError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Effective retrieval</CardTitle>
          <CardDescription>
            The rightmost configured scope wins for newly connected clients.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-1">
          <p className="font-medium capitalize">{effective.method}</p>
          <p className="font-mono text-muted-foreground text-sm">
            {retrievalSourceLabel(effective)}
          </p>
        </CardContent>
      </Card>

      <RetrievalEditor
        key={editorKey}
        config={config}
        initial={override}
        loading={configLoading}
        onScopeChange={setRequestedScope}
        revision={revision}
        scope={scope}
        scopes={scopes}
      />
    </main>
  );
}

function RetrievalEditor({
  config,
  initial,
  loading,
  onScopeChange,
  revision,
  scope,
  scopes,
}: {
  config: ConfigResponse | null;
  initial?: RetrievalConfig;
  loading: boolean;
  onScopeChange: (scope: RatelScope) => void;
  revision?: string;
  scope: RatelScope;
  scopes: RatelScope[];
}) {
  const { busy, context, request, runAction } = useRatelApp();
  const [draft, setDraft] = useState(() => retrievalDraftFromConfig(initial));
  const [preflight, setPreflight] = useState<RetrievalPreflightState | null>(null);
  const draftKey = retrievalDraftKey(draft);
  const visiblePreflight = preflight?.draftKey === draftKey ? preflight.result : null;
  const target = retrievalTarget(scope, context);
  const hasOverride = config?.scopes[scope]?.available
    ? config.scopes[scope].config.retrieval !== undefined
    : false;
  const disabled = busy || loading;

  const configure = async () => {
    await runAction(`Saved ${scope} retrieval override`, async () => {
      const retrieval = retrievalConfigFromDraft(draft);
      const result = await request<{ reconnectMessage?: string }>("/api/retrieval", {
        method: "PATCH",
        body: {
          target,
          retrieval,
          ...(revision ? { expectedRevision: revision } : {}),
        },
      });
      return { log: result.reconnectMessage ? [result.reconnectMessage] : [] };
    });
  };

  const reset = async () => {
    await runAction(`Reset ${scope} retrieval override`, async () =>
      request<{ reconnectMessage?: string }>("/api/retrieval", {
        method: "DELETE",
        body: {
          target,
          ...(revision ? { expectedRevision: revision } : {}),
        },
      }).then((result) => ({
        log: result.reconnectMessage ? [result.reconnectMessage] : [],
      })),
    );
  };

  const prepare = async () => {
    await runAction("Retrieval preflight complete", async () => {
      const preparedDraftKey = retrievalDraftKey(draft);
      const retrieval = retrievalConfigFromDraft(draft);
      const result = await request<RetrievalPreflightView>("/api/retrieval/prepare", {
        method: "POST",
        body: { retrieval },
      });
      setPreflight({ draftKey: preparedDraftKey, result });
      return { log: [result.message] };
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scoped override</CardTitle>
        <CardDescription>
          Configure and prepare one scope. Saving creates a new runtime revision.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-2 sm:max-w-xs">
          <Label htmlFor="retrieval-scope">Scope</Label>
          <Select value={scope} onValueChange={(value) => onScopeChange(value as RatelScope)}>
            <SelectTrigger id="retrieval-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            id="retrieval-method"
            label="Method"
            value={draft.method}
            onChange={(method) =>
              setDraft((current) => ({ ...current, method: method as RetrievalMethod }))
            }
            options={[
              ["bm25", "BM25"],
              ["semantic", "Semantic"],
              ["hybrid", "Hybrid"],
            ]}
          />
          {draft.method !== "bm25" ? (
            <SelectField
              id="retrieval-source"
              label="Embedding source"
              value={draft.source}
              onChange={(source) =>
                setDraft((current) => ({ ...current, source: source as RetrievalSource }))
              }
              options={[
                ["built-in", "Built-in"],
                ["huggingface", "Hugging Face"],
                ["local", "Local path"],
                ["ollama", "Ollama"],
                ["endpoint", "OpenAI-compatible endpoint"],
              ]}
            />
          ) : null}
        </div>

        {showsEmbeddingFields(draft) ? <EmbeddingFields draft={draft} setDraft={setDraft} /> : null}

        <RetrievalDisclosures draft={draft} />

        {visiblePreflight ? (
          <Alert>
            <CheckCircle2 />
            <AlertTitle>Preflight {visiblePreflight.status}</AlertTitle>
            <AlertDescription>{visiblePreflight.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            disabled={disabled}
            onClick={() => void prepare()}
            type="button"
            variant="outline"
          >
            <RefreshCw />
            Prepare
          </Button>
          <Button disabled={disabled} onClick={() => void configure()} type="button">
            <Save />
            Save override
          </Button>
          <Button
            disabled={disabled || !hasOverride}
            onClick={() => void reset()}
            type="button"
            variant="ghost"
          >
            Reset override
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function EmbeddingFields({
  draft,
  setDraft,
}: {
  draft: RetrievalDraft;
  setDraft: React.Dispatch<React.SetStateAction<RetrievalDraft>>;
}) {
  const update = (patch: Partial<RetrievalDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-muted/20 p-4 sm:grid-cols-2">
      {draft.source !== "built-in" ? (
        <TextField
          id="retrieval-model"
          label={draft.source === "local" ? "Model directory" : "Model"}
          placeholder={
            draft.source === "huggingface"
              ? "intfloat/multilingual-e5-small"
              : draft.source === "local"
                ? "~/.cache/models/bge"
                : "nomic-embed-text"
          }
          value={draft.model}
          onChange={(model) => update({ model })}
        />
      ) : null}
      {draft.source === "endpoint" ? (
        <>
          <TextField
            id="retrieval-url"
            label="Embeddings URL"
            placeholder="https://api.example.com/v1/embeddings"
            value={draft.url}
            onChange={(url) => update({ url })}
          />
          <TextField
            id="retrieval-api-key-env"
            label="API key environment variable"
            placeholder="EMBEDDING_API_KEY"
            value={draft.apiKeyEnv}
            onChange={(apiKeyEnv) => update({ apiKeyEnv })}
          />
        </>
      ) : null}
      {draft.source === "huggingface" ? (
        <>
          <TextField
            id="retrieval-revision"
            label="Revision"
            placeholder="main"
            value={draft.revision}
            onChange={(revision) => update({ revision })}
          />
          <label className="flex items-center gap-2 self-end pb-3 text-sm">
            <input
              checked={draft.download}
              onChange={(event) => update({ download: event.currentTarget.checked })}
              type="checkbox"
            />
            Download at dense startup if not cached
          </label>
        </>
      ) : null}
      {draft.source === "huggingface" || draft.source === "local" ? (
        <SelectField
          id="retrieval-pooling"
          label="Pooling"
          value={draft.pooling || "auto"}
          onChange={(pooling) =>
            update({ pooling: pooling === "auto" ? "" : (pooling as "cls" | "mean") })
          }
          options={[
            ["auto", "Auto"],
            ["cls", "CLS"],
            ["mean", "Mean"],
          ]}
        />
      ) : null}
      <TextField
        id="retrieval-query-prefix"
        label="Query prefix"
        placeholder="Optional"
        value={draft.queryPrefix}
        onChange={(queryPrefix) => update({ queryPrefix })}
      />
      <TextField
        id="retrieval-doc-prefix"
        label="Document prefix"
        placeholder="Optional"
        value={draft.docPrefix}
        onChange={(docPrefix) => update({ docPrefix })}
      />
    </div>
  );
}

function RetrievalDisclosures({ draft }: { draft: RetrievalDraft }) {
  if (draft.method === "bm25") {
    return (
      <Alert>
        <AlertTitle>Zero-download path</AlertTitle>
        <AlertDescription>
          BM25 loads no embedding model and sends no embedding requests.
        </AlertDescription>
      </Alert>
    );
  }
  const remote = draft.source === "endpoint";
  return (
    <Alert>
      <AlertTitle>Dense retrieval lifecycle</AlertTitle>
      <AlertDescription className="grid gap-1">
        {draft.source === "built-in" ? (
          <span>
            The pinned built-in model adds roughly 130 MB while loaded and is English-focused.
            Choose a multilingual Hugging Face model when needed.
          </span>
        ) : null}
        {draft.source === "huggingface" || draft.source === "local" ? (
          <span>
            This in-process model&apos;s memory and multilingual coverage vary by model. Hugging
            Face sources use the normal model cache.
          </span>
        ) : null}
        {draft.source === "ollama" || draft.source === "endpoint" ? (
          <span>Model memory is owned by the configured embedding service.</span>
        ) : null}
        <span>
          {remote
            ? "Tool/skill metadata and retrieval queries are sent to the configured endpoint."
            : "Embedding metadata and queries stay on this machine."}
        </span>
        <span>
          Retrieval traces remain under ~/.ratel/telemetry. Reconnect the affected agent/context
          after saving; restart the daemon only as a fallback.
        </span>
      </AlertDescription>
    </Alert>
  );
}

function SelectField({
  id,
  label,
  onChange,
  options,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function TextField({
  id,
  label,
  onChange,
  placeholder,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        value={value}
      />
    </div>
  );
}

export function retrievalDraftFromConfig(config: RetrievalConfig | undefined): RetrievalDraft {
  const embedding = config?.embedding;
  const draft: RetrievalDraft = {
    method: config?.method ?? "bm25",
    source: "built-in",
    model: "",
    url: "",
    apiKeyEnv: "",
    revision: "",
    download: false,
    queryPrefix: "",
    docPrefix: "",
    pooling: "",
  };
  if (embedding === undefined) return draft;
  if (typeof embedding === "string") {
    return { ...draft, source: "local", model: embedding };
  }
  const shared = {
    queryPrefix: embedding.queryPrefix ?? "",
    docPrefix: embedding.docPrefix ?? "",
  };
  if ("huggingface" in embedding) {
    return {
      ...draft,
      ...shared,
      source: "huggingface",
      model: embedding.huggingface,
      revision: embedding.revision ?? "",
      download: embedding.download ?? false,
      pooling: embedding.pooling ?? "",
    };
  }
  if ("local" in embedding) {
    return {
      ...draft,
      ...shared,
      source: "local",
      model: embedding.local,
      pooling: embedding.pooling ?? "",
    };
  }
  if ("ollama" in embedding) {
    return { ...draft, ...shared, source: "ollama", model: embedding.ollama };
  }
  return {
    ...draft,
    ...shared,
    source: "endpoint",
    model: embedding.model ?? "",
    url: embedding.url ?? "",
    apiKeyEnv: embedding.apiKeyEnv ?? "",
  };
}

export function retrievalDraftKey(draft: RetrievalDraft): string {
  return JSON.stringify(draft);
}

export function showsEmbeddingFields(draft: RetrievalDraft): boolean {
  return draft.method !== "bm25" && draft.source !== "built-in";
}

export function retrievalConfigFromDraft(draft: RetrievalDraft): RetrievalConfig {
  if (draft.method === "bm25") return { method: "bm25" };
  const shared = {
    ...(draft.queryPrefix ? { queryPrefix: draft.queryPrefix } : {}),
    ...(draft.docPrefix ? { docPrefix: draft.docPrefix } : {}),
  };
  let embedding: RetrievalConfig["embedding"];
  if (draft.source === "huggingface") {
    embedding = {
      huggingface: requiredDraftValue(draft.model, "Hugging Face model"),
      ...shared,
      ...(draft.revision ? { revision: draft.revision } : {}),
      ...(draft.pooling ? { pooling: draft.pooling } : {}),
      download: draft.download,
    };
  } else if (draft.source === "local") {
    embedding = {
      local: requiredDraftValue(draft.model, "Local model directory"),
      ...shared,
      ...(draft.pooling ? { pooling: draft.pooling } : {}),
    };
  } else if (draft.source === "ollama") {
    embedding = {
      ollama: requiredDraftValue(draft.model, "Ollama model"),
      ...shared,
    };
  } else if (draft.source === "endpoint") {
    embedding = {
      url: requiredDraftValue(draft.url, "Endpoint URL"),
      model: requiredDraftValue(draft.model, "Endpoint model"),
      ...shared,
      ...(draft.apiKeyEnv ? { apiKeyEnv: draft.apiKeyEnv } : {}),
    };
  }
  return {
    method: draft.method,
    ...(embedding !== undefined ? { embedding } : {}),
  };
}

export function availableRetrievalScopes(context: RuntimeUiContext): RatelScope[] {
  return context.kind === "project" ? ["user", "project", "local"] : ["user"];
}

export function retrievalTarget(scope: RatelScope, context: RuntimeUiContext) {
  if (scope === "user") return { scope: "user" as const };
  if (context.kind !== "project") throw new Error(`${scope} retrieval requires a project context`);
  return { scope, projectId: context.projectId };
}

function effectiveRetrieval(config: ConfigResponse | null): RetrievalConfig {
  if (config?.effectiveRetrieval) return config.effectiveRetrieval;
  let effective: RetrievalConfig = { method: "bm25" };
  for (const scope of ["user", "project", "local"] as const) {
    const state = config?.scopes[scope];
    if (state?.available && state.config.retrieval) effective = state.config.retrieval;
  }
  return effective;
}

function documentRevisionForScope(
  config: ConfigResponse | null,
  scope: RatelScope,
): string | undefined {
  return config?.documents?.find(({ ref }) => ref.scope === scope)?.documentRevision;
}

function retrievalSourceLabel(retrieval: RetrievalConfig): string {
  if (retrieval.method === "bm25") return "model-free";
  const embedding = retrieval.embedding;
  if (embedding === undefined) return "BAAI/bge-small-en-v1.5 (built-in)";
  if (typeof embedding === "string") return embedding;
  if ("huggingface" in embedding) return embedding.huggingface;
  if ("local" in embedding) return embedding.local;
  if ("ollama" in embedding) return `Ollama · ${embedding.ollama}`;
  return `${embedding.model} · ${embedding.url}`;
}

function requiredDraftValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
