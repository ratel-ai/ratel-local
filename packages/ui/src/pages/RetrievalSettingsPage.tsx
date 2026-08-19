import { useMutation, useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { type ConfigResponse, type RatelScope, type RetrievalConfig, useRatelApp } from "@/App";
import {
  PageHeader,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { streamRatelApi } from "@/lib/ratel-api";
import { ratelQueryKeys } from "@/lib/ratel-query";
import type { RuntimeUiContext } from "@/lib/runtime-context";
import { useRatelMutation } from "@/lib/use-ratel-mutation";
import { cn } from "@/lib/utils";
import { AgentSettingsSection, type AgentSetupRouteData } from "@/pages/AgentSetupPage";

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

export interface RetrievalPreparationInspection {
  action: "none" | "verify" | "download-and-verify";
  method: RetrievalMethod;
  source: RetrievalPreflightView["source"] | "none";
  model?: string;
  runtimeMemoryMb: number | null;
  remoteDataTransfer: boolean;
}

export interface RetrievalPreparationProgress {
  phase: "downloading" | "verifying";
  file?: string;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

type RetrievalPreparationStreamEvent =
  | { type: "progress"; progress: RetrievalPreparationProgress }
  | { type: "result"; result: RetrievalPreflightView }
  | { type: "error"; error: string };

export interface CloudTraceSettingsStatus {
  featureEnabled?: boolean;
  configured: boolean;
  endpoint: string;
}

interface RetrievalWriteVariables {
  action: "configure" | "reset";
  draft: RetrievalDraft;
  revision?: string;
  scope: RatelScope;
  target: ReturnType<typeof retrievalTarget>;
}

export function SettingsPage({
  initialAgentData,
}: {
  initialAgentData?: AgentSetupRouteData;
} = {}) {
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
    <main className="flex w-full flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Settings</PageHeaderTitle>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Manage agents, cloud tracing, and retrieval.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      <AgentSettingsSection initialData={initialAgentData} />

      <CloudTraceSettingsSection />

      {configError ? (
        <Alert variant="destructive">
          <AlertTitle>Configuration unavailable</AlertTitle>
          <AlertDescription>{configError}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="retrieval-settings-title" className="grid gap-3">
        <div className="grid gap-1 px-1">
          <h2 className="text-lg font-semibold" id="retrieval-settings-title">
            Retrieval
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose how Ratel finds relevant tools and skills.
          </p>
        </div>

        <section
          aria-label="Current retrieval method"
          className="flex min-h-12 items-center gap-3 rounded-xl border border-forest-300 bg-forest-600/40 px-4 py-3 text-sm"
        >
          <span className="shrink-0 text-muted-foreground">Current</span>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          <p className="min-w-0 truncate">
            <span className="font-medium">{retrievalMethodLabel(effective.method)}</span>
            {effective.method !== "bm25" ? (
              <span className="text-muted-foreground"> · {retrievalSourceLabel(effective)}</span>
            ) : null}
          </p>
        </section>

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
      </section>
    </main>
  );
}

export const RetrievalSettingsPage = SettingsPage;

function CloudTraceSettingsSection() {
  const { request } = useRatelApp();
  const cloudQuery = useQuery({
    queryKey: ratelQueryKeys.cloudTraces(),
    queryFn: () => request<CloudTraceSettingsStatus>("/api/cloud-traces"),
  });
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [editingApiKey, setEditingApiKey] = useState(false);
  useEffect(() => {
    if (cloudQuery.data) setEndpoint(cloudQuery.data.endpoint);
  }, [cloudQuery.data]);
  const saveMutation = useRatelMutation<
    CloudTraceSettingsStatus,
    { endpoint: string; apiKey: string }
  >({
    invalidate: [ratelQueryKeys.cloudTraces()],
    mutationKey: [...ratelQueryKeys.cloudTraces(), "save"],
    mutationFn: ({ endpoint: nextEndpoint, apiKey: nextApiKey }) =>
      request("/api/cloud-traces", {
        method: "PATCH",
        body: cloudTraceSettingsPatch(
          {
            configured: cloudQuery.data?.configured ?? false,
            endpoint: nextEndpoint,
          },
          nextApiKey,
        ),
      }),
    onSuccess: (status) => {
      setApiKey("");
      setEditingApiKey(false);
      setEndpoint(status.endpoint);
    },
    successMessage: "Saved Ratel Cloud trace settings",
  });
  const apiKeyConfigured = cloudQuery.data?.configured ?? false;
  const showApiKeyInput = !apiKeyConfigured || editingApiKey;

  if (cloudQuery.data?.featureEnabled === false) {
    return (
      <section aria-labelledby="cloud-settings-title" className="grid gap-3">
        <div className="grid gap-1 px-1">
          <h2 className="text-lg font-semibold" id="cloud-settings-title">
            Ratel Cloud
          </h2>
        </div>
        <Alert>
          <AlertTitle>Cloud telemetry is off</AlertTitle>
          <AlertDescription>
            Start a foreground daemon with RATEL_FEATURE_CLOUD_TELEMETRY=1, or reinstall the
            background service with that environment, to enable this experimental integration.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  return (
    <section aria-labelledby="cloud-settings-title" className="grid gap-3">
      <div className="grid gap-1 px-1">
        <h2 className="text-lg font-semibold" id="cloud-settings-title">
          Ratel Cloud
        </h2>
        <p className="text-sm text-muted-foreground">Configure trace export to Ratel Cloud.</p>
      </div>
      <Card className="rounded-2xl border-forest-300 bg-forest-600/40 shadow-none">
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="cloud-trace-endpoint">Trace endpoint</Label>
            <Input
              id="cloud-trace-endpoint"
              onChange={(event) => setEndpoint(event.currentTarget.value)}
              placeholder="https://cloud.ratel.sh/api/v1/traces"
              value={endpoint}
            />
          </div>
          {showApiKeyInput ? (
            <div className="grid gap-2">
              <Label htmlFor="cloud-api-key">API key</Label>
              <Input
                autoComplete="off"
                autoFocus={editingApiKey}
                id="cloud-api-key"
                onChange={(event) => setApiKey(event.currentTarget.value)}
                placeholder={apiKeyConfigured ? "Enter a replacement key" : "rtl_…"}
                type="password"
                value={apiKey}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  The key is stored by the local daemon and is never returned to this page.
                </p>
                {apiKeyConfigured ? (
                  <Button
                    onClick={() => {
                      setApiKey("");
                      setEditingApiKey(false);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-border px-3 py-2">
              <div className="grid gap-1">
                <p className="font-medium text-sm">API key</p>
                <p className="inline-flex items-center gap-1.5 text-emerald-700 text-xs dark:text-emerald-300">
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" />
                  Configured
                </p>
              </div>
              <Button
                onClick={() => setEditingApiKey(true)}
                size="sm"
                type="button"
                variant="outline"
              >
                Edit
              </Button>
            </div>
          )}
          {cloudQuery.error ? (
            <p className="text-sm text-destructive">{cloudQuery.error.message}</p>
          ) : null}
          <div>
            <Button
              disabled={
                cloudQuery.isPending ||
                saveMutation.isPending ||
                !endpoint.trim() ||
                (showApiKeyInput && !apiKey.trim())
              }
              onClick={() =>
                saveMutation.mutate({
                  endpoint: endpoint.trim(),
                  apiKey,
                })
              }
            >
              <Save />
              {saveMutation.isPending ? "Saving…" : "Save Cloud settings"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
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
  const { context, request, token } = useRatelApp();
  const [draft, setDraft] = useState(() => retrievalDraftFromConfig(initial));
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [savePhase, setSavePhase] = useState<"idle" | "preparing" | "saving">("idle");
  const [inspection, setInspection] = useState<RetrievalPreparationInspection | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<RetrievalPreparationProgress | null>(
    null,
  );
  const target = retrievalTarget(scope, context);
  const hasOverride = config?.scopes[scope]?.available
    ? config.scopes[scope].config.retrieval !== undefined
    : false;
  const writeMutation = useRatelMutation<unknown, RetrievalWriteVariables>({
    invalidate: [ratelQueryKeys.config(context)],
    mutationKey: [...ratelQueryKeys.config(context), "retrieval", "write"],
    mutationFn: ({ action, draft: nextDraft, revision: expectedRevision, target: nextTarget }) =>
      request("/api/retrieval", {
        method: action === "configure" ? "PATCH" : "DELETE",
        body: {
          target: nextTarget,
          ...(action === "configure" ? { retrieval: retrievalConfigFromDraft(nextDraft) } : {}),
          ...(expectedRevision ? { expectedRevision } : {}),
        },
      }),
    successMessage: (_result, variables) =>
      variables.action === "configure"
        ? `Saved ${retrievalScopeLabel(variables.scope)} retrieval settings`
        : variables.scope === "user"
          ? "Restored the default retrieval setting"
          : `Using inherited retrieval for ${retrievalScopeLabel(variables.scope)}`,
  });
  const preparationMutation = useMutation({
    mutationKey: [...ratelQueryKeys.context(context), "retrieval", "preflight"],
    mutationFn: async (nextDraft: RetrievalDraft) => {
      let result: RetrievalPreflightView | null = null;
      await streamRatelApi<RetrievalPreparationStreamEvent>(
        { context, token },
        "/api/retrieval/prepare/stream",
        {
          method: "POST",
          body: { retrieval: retrievalConfigFromDraft(nextDraft) },
        },
        (event) => {
          if (event.type === "progress") setDownloadProgress(event.progress);
          if (event.type === "result") result = event.result;
          if (event.type === "error") throw new Error(event.error);
        },
      );
      if (!result) throw new Error("Retrieval preparation ended without a result");
      return result as RetrievalPreflightView;
    },
  });
  const inspectionMutation = useMutation({
    mutationKey: [...ratelQueryKeys.context(context), "retrieval", "inspect"],
    mutationFn: (nextDraft: RetrievalDraft) =>
      request("/api/retrieval/inspect", {
        method: "POST",
        body: { retrieval: retrievalConfigFromDraft(nextDraft) },
      }) as Promise<RetrievalPreparationInspection>,
  });
  const disabled =
    writeMutation.isPending ||
    preparationMutation.isPending ||
    inspectionMutation.isPending ||
    loading;
  const writeVariables = { draft, revision, scope, target };
  const resetLabel = scope === "user" ? "Restore default" : "Use inherited setting";

  const save = async () => {
    preparationMutation.reset();
    inspectionMutation.reset();
    setInspection(null);
    if (!retrievalNeedsPreparation(draft)) {
      writeMutation.mutate({ ...writeVariables, action: "configure" });
      return;
    }
    try {
      const result = await inspectionMutation.mutateAsync(draft);
      setInspection(result);
      if (result.action === "download-and-verify") {
        setSavePhase("idle");
        setConfirmationOpen(true);
        return;
      }
      await prepareAndSave();
    } catch {
      // Inspection errors are shown next to the Save action.
    }
  };

  const prepareAndSave = async () => {
    setSavePhase("preparing");
    setDownloadProgress(null);
    try {
      await preparationMutation.mutateAsync(draft);
      setSavePhase("saving");
      await writeMutation.mutateAsync({ ...writeVariables, action: "configure" });
      setConfirmationOpen(false);
    } catch {
      // Preparation errors are shown in the dialog. Write errors use the shared mutation toast.
    } finally {
      setSavePhase("idle");
    }
  };

  return (
    <>
      <Card className="rounded-2xl border-forest-300 bg-forest-600/40 shadow-none">
        <CardContent className="grid gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="retrieval-scope">Scope</Label>
              <Select value={scope} onValueChange={(value) => onScopeChange(value as RatelScope)}>
                <SelectTrigger id="retrieval-scope" className="w-full">
                  <SelectValue>{retrievalScopeLabel(scope)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((value) => (
                    <SelectItem key={value} value={value}>
                      {retrievalScopeLabel(value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SelectField
              className="sm:col-start-1"
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

          {showsEmbeddingFields(draft) ? (
            <EmbeddingFields draft={draft} setDraft={setDraft} />
          ) : null}

          <RetrievalDisclosures draft={draft} />

          {inspectionMutation.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t check retrieval requirements</AlertTitle>
              <AlertDescription>{errorMessage(inspectionMutation.error)}</AlertDescription>
            </Alert>
          ) : null}

          {preparationMutation.isError && !confirmationOpen ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t verify retrieval</AlertTitle>
              <AlertDescription>{errorMessage(preparationMutation.error)}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={disabled} onClick={() => void save()} type="button">
              <Save />
              {inspectionMutation.isPending ? (
                <Button.LoadingIndicator label="Checking retrieval requirements" />
              ) : preparationMutation.isPending && !confirmationOpen ? (
                <Button.LoadingIndicator label="Verifying retrieval" />
              ) : writeMutation.isPending &&
                writeMutation.variables?.action === "configure" &&
                !confirmationOpen ? (
                <Button.LoadingIndicator label="Saving retrieval settings" />
              ) : null}
              Save
            </Button>
            <Button
              disabled={disabled || !hasOverride}
              onClick={() => writeMutation.mutate({ ...writeVariables, action: "reset" })}
              type="button"
              variant="ghost"
            >
              {writeMutation.isPending && writeMutation.variables?.action === "reset" ? (
                <Button.LoadingIndicator label={resetLabel} />
              ) : null}
              {resetLabel}
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmationOpen}
        onOpenChange={(open) => {
          if (savePhase === "idle") setConfirmationOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {savePhase === "preparing"
                ? "Downloading and verifying the model…"
                : savePhase === "saving"
                  ? "Saving retrieval settings…"
                  : inspection
                    ? retrievalDownloadConfirmationCopy(inspection).title
                    : "Download the model?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {savePhase === "idle"
                ? inspection
                  ? retrievalDownloadConfirmationCopy(inspection).description
                  : "This model must be downloaded before retrieval can be saved."
                : "Keep this window open while Ratel finishes."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {savePhase !== "idle" ? (
            <Progress value={retrievalProgressValue(savePhase, downloadProgress)}>
              <ProgressLabel>{retrievalProgressLabel(savePhase, downloadProgress)}</ProgressLabel>
              {savePhase === "preparing" && downloadProgress ? (
                <ProgressValue>
                  {() =>
                    formatByteProgress(downloadProgress.loadedBytes, downloadProgress.totalBytes)
                  }
                </ProgressValue>
              ) : null}
            </Progress>
          ) : null}

          {preparationMutation.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t prepare retrieval</AlertTitle>
              <AlertDescription>{errorMessage(preparationMutation.error)}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={savePhase !== "idle"}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={savePhase !== "idle"}
              onClick={() => void prepareAndSave()}
            >
              {savePhase !== "idle" ? (
                <Button.LoadingIndicator label="Downloading and verifying the retrieval model" />
              ) : null}
              {preparationMutation.isError ? "Try again" : "Download and save"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
        <AlertTitle>No embedding model required</AlertTitle>
        <AlertDescription>
          BM25 uses local keyword search. It does not download a model or send data to an embedding
          service.
        </AlertDescription>
      </Alert>
    );
  }
  const remote = draft.source === "endpoint";
  return (
    <Alert>
      <AlertTitle>About this embedding source</AlertTitle>
      <AlertDescription className="grid gap-1">
        {draft.source === "built-in" ? (
          <span>
            The built-in model uses about 130 MB of memory and works best with English content.
          </span>
        ) : null}
        {draft.source === "huggingface" || draft.source === "local" ? (
          <span>
            Memory use and language support depend on the model. Hugging Face models use the local
            model cache.
          </span>
        ) : null}
        {draft.source === "ollama" || draft.source === "endpoint" ? (
          <span>The configured embedding service manages the model and its memory.</span>
        ) : null}
        <span>
          {remote
            ? "Tool and skill metadata, along with search queries, will be sent to this endpoint."
            : "Tool and skill metadata, along with search queries, stay on this machine."}
        </span>
        <span>Reconnect affected clients after saving so they use the new retrieval method.</span>
      </AlertDescription>
    </Alert>
  );
}

function SelectField({
  className,
  id,
  label,
  onChange,
  options,
  value,
}: {
  className?: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
  value: string;
}) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{selectOptionLabel(options, value)}</SelectValue>
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

export function cloudTraceSettingsPatch(
  status: CloudTraceSettingsStatus,
  apiKey: string,
): { endpoint: string; apiKey?: string } {
  const trimmedApiKey = apiKey.trim();
  if (!status.configured && !trimmedApiKey) {
    throw new Error("Ratel Cloud API key is required");
  }
  return {
    endpoint: status.endpoint.trim(),
    ...(trimmedApiKey ? { apiKey: trimmedApiKey } : {}),
  };
}

export function retrievalDraftKey(draft: RetrievalDraft): string {
  return JSON.stringify(draft);
}

export function retrievalMethodLabel(method: RetrievalMethod): string {
  if (method === "bm25") return "BM25";
  return method === "semantic" ? "Semantic" : "Hybrid";
}

export function retrievalScopeLabel(scope: RatelScope): string {
  if (scope === "user") return "User";
  return scope === "project" ? "Project" : "Local";
}

export function retrievalNeedsPreparation(draft: RetrievalDraft): boolean {
  return draft.method !== "bm25";
}

export function retrievalDownloadConfirmationCopy(inspection: RetrievalPreparationInspection): {
  description: string;
  title: string;
} {
  if (inspection.source === "built-in") {
    return {
      title: "Download the built-in model?",
      description:
        "The built-in embedding model is not cached on this machine. Ratel will download it once, verify it, then save these settings.",
    };
  }
  return {
    title: "Download the embedding model?",
    description: `${inspection.model ?? "The selected embedding model"} is not cached on this machine. Ratel will download it, verify it, then save these settings.`,
  };
}

export function retrievalProgressValue(
  savePhase: "idle" | "preparing" | "saving",
  progress: RetrievalPreparationProgress | null,
): number | null {
  if (savePhase !== "preparing" || !progress) return null;
  return progress.phase === "verifying" ? 100 : Math.max(0, Math.min(100, progress.percent));
}

export function retrievalProgressLabel(
  savePhase: "idle" | "preparing" | "saving",
  progress: RetrievalPreparationProgress | null,
): string {
  if (savePhase === "saving") return "Saving settings…";
  if (progress?.phase === "verifying") return "Verifying the model…";
  if (progress?.phase === "downloading") {
    return progress.file ? `Downloading ${progress.file}…` : "Downloading the model…";
  }
  return "Preparing retrieval…";
}

function formatByteProgress(loadedBytes: number, totalBytes: number): string {
  const percent = totalBytes === 0 ? 100 : Math.min(100, (loadedBytes / totalBytes) * 100);
  return `${formatBytes(loadedBytes)} of ${formatBytes(totalBytes)} · ${Math.round(percent)}%`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
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
  if (retrieval.method === "bm25") return "No embedding model";
  const embedding = retrieval.embedding;
  if (embedding === undefined) return "Built-in";
  if (typeof embedding === "string") return embedding;
  if ("huggingface" in embedding) return embedding.huggingface;
  if ("local" in embedding) return embedding.local;
  if ("ollama" in embedding) return `Ollama · ${embedding.ollama}`;
  return `${embedding.model} · ${embedding.url}`;
}

function selectOptionLabel(
  options: ReadonlyArray<readonly [string, string]>,
  value: string,
): string {
  return options.find(([optionValue]) => optionValue === value)?.[1] ?? value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The retrieval model could not be prepared.";
}

function requiredDraftValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
