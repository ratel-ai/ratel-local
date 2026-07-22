import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import * as z from "zod";
import {
  type AuthStatus,
  authBadgeVariant,
  type ConfigResponse,
  keyValsToText,
  parseKeyValueLines,
  type RatelScope,
  SCOPES,
  type ServerEntry,
  type ServerToolTokenEstimate,
  summaryOf,
  toolSourceCreatePath,
  toolSourcePath,
  useRatelApp,
} from "@/App";
import { CodeBlock } from "@/components/code-block";
import { EmptyStateIcon } from "@/components/empty-state-icon";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
  ResponsiveToolbarLabeledButton,
} from "@/components/responsive-toolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { DetailGrid, DetailLabel } from "@/components/ui/detail-grid";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { type Segment, SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { scopeTarget } from "@/lib/runtime-context";
import {
  AUTH_STATUS_LABELS,
  authStatusLabel as getAuthStatusLabel,
  TOOL_SOURCE_TYPE_LABELS,
  type ToolSourceType,
  toolSourceTypeLabel,
} from "@/lib/tool-source-labels";
import { cn } from "@/lib/utils";

type AuthFilter = "all" | AuthStatus;
type TypeFilter = "all" | EntryType;
type EntryType = ToolSourceType;
type ArgumentFormRow = { id: string; value: string };
type EntryFormValues = {
  args: ArgumentFormRow[];
  callbackPort: string;
  clientId: string;
  clientSecret: string;
  command: string;
  cwd: string;
  description: string;
  env: string;
  headers: string;
  name: string;
  oauthScope: string;
  type: EntryType;
  url: string;
};

const TOOL_SOURCE_GRID = "lg:grid-cols-[minmax(12rem,1.05fr)_7rem_minmax(13rem,1fr)_10rem_12rem]";
const ENTRY_INPUT_CLASS = "bg-background placeholder:text-muted-foreground/45";
const ENTRY_TEXTAREA_CLASS =
  "min-h-28 bg-background font-mono text-sm placeholder:text-muted-foreground/45";

const entryNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dots, underscores, or dashes.");
const optionalTrimmedStringSchema = z.string().transform((value) => value.trim() || undefined);
const argsArraySchema = z
  .array(z.object({ id: z.string(), value: z.string() }))
  .transform((value) => {
    const parsed = value.map((item) => item.value.trim()).filter(Boolean);
    return parsed.length ? parsed : undefined;
  });
const keyValueLinesSchema = (separator: "=" | ":") =>
  z.string().transform((value) => {
    const parsed = parseKeyValueLines(value, separator);
    return Object.keys(parsed).length ? parsed : undefined;
  });
const optionalCallbackPortSchema = z
  .string()
  .trim()
  .refine((value) => {
    if (!value) return true;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535;
  }, "Use a port between 0 and 65535.")
  .transform((value) => (value ? Number(value) : undefined));

const entryFormBaseSchema = z.object({
  args: z.array(z.object({ id: z.string(), value: z.string() })),
  callbackPort: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  command: z.string(),
  cwd: z.string(),
  description: z.string().max(240, "Keep the description under 240 characters."),
  env: z.string(),
  headers: z.string(),
  name: entryNameSchema,
  oauthScope: z.string(),
  type: z.enum(["stdio", "http", "sse"]),
  url: z.string(),
});

const stdioEntrySchema = entryFormBaseSchema
  .extend({
    command: z.string().trim().min(1, "Command is required for stdio sources."),
    type: z.literal("stdio"),
  })
  .transform(
    (value): ServerEntry =>
      compactEntry({
        args: argsArraySchema.parse(value.args),
        command: value.command,
        cwd: optionalTrimmedStringSchema.parse(value.cwd),
        description: optionalTrimmedStringSchema.parse(value.description),
        env: keyValueLinesSchema("=").parse(value.env),
        type: value.type,
      }),
  );

const remoteEntrySchema = entryFormBaseSchema
  .extend({
    callbackPort: optionalCallbackPortSchema,
    type: z.enum(["http", "sse"]),
    url: z.string().trim().min(1, "URL is required for HTTP and SSE sources.").url({
      message: "Enter a valid absolute URL.",
    }),
  })
  .transform(
    (value): ServerEntry =>
      compactEntry({
        callbackPort: value.callbackPort,
        clientId: optionalTrimmedStringSchema.parse(value.clientId),
        clientSecret: optionalTrimmedStringSchema.parse(value.clientSecret),
        description: optionalTrimmedStringSchema.parse(value.description),
        headers: keyValueLinesSchema(":").parse(value.headers),
        scope: optionalTrimmedStringSchema.parse(value.oauthScope),
        type: value.type,
        url: value.url,
      }),
  );

const entryBodySchema = z.discriminatedUnion("type", [stdioEntrySchema, remoteEntrySchema]);
const entryFormSchema = entryFormBaseSchema.superRefine((value, context) => {
  const result = entryBodySchema.safeParse(value);
  if (result.success) return;
  for (const issue of result.error.issues) {
    context.addIssue({ code: "custom", message: issue.message, path: issue.path });
  }
});
const entrySubmitSchema = entryFormSchema.transform((value, context) => {
  const result = entryBodySchema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return { entry: result.data, name: value.name };
});

export function ToolsPage() {
  const navigate = useNavigate();
  const {
    busy,
    config,
    context,
    pagePath,
    refresh,
    request,
    runAction,
    token,
    triggerSetupIntent,
  } = useRatelApp();
  const [scope, setScope] = useState<RatelScope>("user");
  const [authFilter, setAuthFilter] = useState<AuthFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const visibleScopes = context.kind === "project" ? SCOPES : SCOPES.slice(0, 1);
  const scopeOptions: Segment<RatelScope>[] = visibleScopes.map((value) => ({
    label: scopeLabel(value),
    value,
  }));

  const scopeData = config?.scopes[scope];
  const servers = scopeData?.available ? scopeData.config.mcpServers : {};
  const scopeEntries = Object.entries(servers);
  const scopeEstimates = scopeEntries
    .map(([name]) => config?.toolTokenEstimatesByServer?.[name])
    .filter((estimate): estimate is ServerToolTokenEstimate => Boolean(estimate));
  const scopeMeasuredSourceCount = scopeEstimates.length;
  const scopeToolCount = scopeEstimates.reduce((sum, estimate) => sum + estimate.toolCount, 0);
  const scopeEstimatedTokens = scopeEstimates.reduce(
    (sum, estimate) => sum + estimate.estimatedTokens,
    0,
  );
  const rows = Object.entries(servers)
    .map(([name, entry]) => ({
      authStatus: scopeData?.available ? scopeData.authStatus[name] : undefined,
      entry,
      name,
      usage: config?.toolTokenEstimatesByServer?.[name],
    }))
    .filter((row) => typeFilter === "all" || entryTypeOf(row.entry) === typeFilter)
    .filter((row) => authFilter === "all" || authStatusOf(row.authStatus) === authFilter)
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasActiveFilters = typeFilter !== "all" || authFilter !== "all";
  const goToCreateSource = (targetScope: RatelScope = scope) => {
    void navigate({ to: toolSourceCreatePath(targetScope, token, context) } as never);
  };

  return (
    <main className="grid w-full gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Tool Sources</PageHeaderTitle>
            <div className="flex items-center gap-1 sm:hidden">
              <Button
                aria-label="Refresh"
                onClick={() => void refresh()}
                size="icon-lg"
                type="button"
                variant="outline"
              >
                <RefreshCw />
                <span className="sr-only">Refresh</span>
              </Button>
              <Button
                aria-label="Add source"
                disabled={!scopeData?.available}
                onClick={() => goToCreateSource()}
                size="icon-lg"
                type="button"
              >
                <Plus />
                <span className="sr-only">Add source</span>
              </Button>
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Current MCP server entries, grouped by local Ratel scope.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden sm:flex">
          <ResponsiveToolbar>
            <ResponsiveToolbarGroup>
              <ResponsiveToolbarButton
                icon={<RefreshCw />}
                kbd="⌘R"
                label="Refresh"
                onClick={() => void refresh()}
              />
            </ResponsiveToolbarGroup>
            <ResponsiveToolbarLabeledButton
              disabled={!scopeData?.available}
              icon={<Plus />}
              label="Add source"
              onClick={() => goToCreateSource()}
              variant="default"
            />
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      <section className="flex flex-col gap-3 rounded-2xl border border-forest-300 bg-forest-600/40 p-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <SegmentedControl<RatelScope>
            ariaLabel="Tool source scope"
            onChange={setScope}
            options={scopeOptions}
            value={scope}
          />
          <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
            {scopeData?.available ? scopeData.path : "scope unavailable"}
          </p>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {scopeData?.available
              ? formatScopeTokenSummary({
                  estimatedTokens: scopeEstimatedTokens,
                  measuredSourceCount: scopeMeasuredSourceCount,
                  sourceCount: scopeEntries.length,
                  toolCount: scopeToolCount,
                })
              : "Tool counts unavailable"}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:w-fit">
          <ToolSourceFilterSelect
            label="Type"
            valueLabel={typeFilter === "all" ? "All types" : toolSourceTypeLabel(typeFilter)}
            value={typeFilter}
            onValueChange={(value) => setTypeFilter(value as TypeFilter)}
          >
            <SelectItem value="all">All types</SelectItem>
            {Object.entries(TOOL_SOURCE_TYPE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </ToolSourceFilterSelect>
          <ToolSourceFilterSelect
            label="Auth"
            valueLabel={authFilter === "all" ? "All auth" : getAuthStatusLabel(authFilter)}
            value={authFilter}
            onValueChange={(value) => setAuthFilter(value as AuthFilter)}
          >
            <SelectItem value="all">All auth</SelectItem>
            {Object.entries(AUTH_STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </ToolSourceFilterSelect>
        </div>
      </section>

      {!scopeData?.available ? (
        <EmptyTools
          action={
            <Button disabled size="sm">
              Add tool source
            </Button>
          }
          title="Scope unavailable"
        >
          Ratel could not resolve this config scope in the current working directory.
        </EmptyTools>
      ) : rows.length === 0 ? (
        <EmptyTools
          action={
            hasActiveFilters ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  onClick={() => {
                    setTypeFilter("all");
                    setAuthFilter("all");
                  }}
                  size="sm"
                >
                  Clear filters
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => goToCreateSource()} size="sm">
                  <Plus />
                  Add tool source
                </Button>
                <Button
                  onClick={() => {
                    triggerSetupIntent("import");
                    void navigate({ to: pagePath("/agent-setup") } as never);
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Wand2 />
                  Import from agent
                </Button>
              </div>
            )
          }
          title={hasActiveFilters ? "No matching tool sources" : "No tool sources in this scope"}
        >
          {hasActiveFilters
            ? "Adjust the type or auth filters to broaden the current source list."
            : "Add a source directly, or import detected entries from an agent config."}
        </EmptyTools>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40">
          <div
            className={cn(
              "hidden gap-3 border-border border-b px-4 py-2.5 font-mono text-[11px] font-normal tracking-[0.08em] text-muted-foreground uppercase sm:px-6 lg:grid",
              TOOL_SOURCE_GRID,
            )}
          >
            <span>Tool Source</span>
            <span>Type</span>
            <span>Target</span>
            <span>Tools</span>
            <span>Auth</span>
          </div>
          <div className="divide-y divide-border/60">
            {rows.map(({ authStatus, entry, name, usage }) => (
              <ToolSourceRow
                authStatus={authStatus}
                busy={busy}
                entry={entry}
                key={name}
                name={name}
                usage={usage}
                onAuthorize={() => {
                  return runAction("Authorization updated", () =>
                    request(`/api/auth/${encodeURIComponent(name)}`, {
                      method: "POST",
                      body: {},
                    }),
                  );
                }}
                onOpen={() => {
                  void navigate({ to: toolSourcePath(scope, name, token, context) } as never);
                }}
              />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function ToolSourceRow(props: {
  authStatus?: AuthStatus;
  busy: boolean;
  entry: ServerEntry;
  name: string;
  onAuthorize: () => Promise<unknown> | undefined;
  onOpen: () => void;
  usage?: ServerToolTokenEstimate;
}) {
  const canAuthorize =
    (props.entry.type === "http" || props.entry.type === "sse") &&
    (props.authStatus === "needs auth" || props.authStatus === "expired");

  return (
    <div
      className={cn(
        "relative grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-4 transition-colors hover:bg-forest/30 focus-within:bg-forest/30 sm:px-6 lg:grid lg:items-center lg:py-3",
        TOOL_SOURCE_GRID,
      )}
    >
      <button
        aria-label={`Open ${props.name}`}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
        onClick={props.onOpen}
        type="button"
      />
      <div className="pointer-events-none relative z-20 order-1 col-span-2 min-w-0 lg:order-none lg:col-span-1">
        <div className="flex min-w-0 items-center gap-2">
          <strong className="truncate font-medium">{props.name}</strong>
          <Badge className="shrink-0" variant="outline">
            MCP
          </Badge>
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {props.entry.description || "No description stored for this tool source."}
        </p>
      </div>
      <div className="pointer-events-none relative z-20 order-2 col-span-1 grid gap-1.5 lg:order-none lg:col-span-1 lg:block">
        <span className="font-mono text-[10px] text-muted-foreground uppercase lg:hidden">
          Transport
        </span>
        <Badge className="font-mono" variant="secondary">
          {toolSourceTypeLabel(entryTypeOf(props.entry))}
        </Badge>
      </div>
      <div className="pointer-events-none relative z-20 order-4 col-span-2 grid min-w-0 gap-1.5 lg:order-none lg:col-span-1">
        <span className="font-mono text-[10px] text-muted-foreground uppercase lg:hidden">
          Target
        </span>
        <code className="block min-w-0 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
          {summaryOf(props.entry)}
        </code>
      </div>
      <div className="pointer-events-none relative z-20 order-3 col-span-1 grid min-w-0 gap-1.5 lg:order-none lg:col-span-1">
        <span className="font-mono text-[10px] text-muted-foreground uppercase lg:hidden">
          Tools
        </span>
        <ToolCountLabel usage={props.usage} />
      </div>
      <div className="relative z-30 order-5 col-span-2 grid gap-1.5 sm:col-span-1 lg:order-none lg:col-span-1 lg:flex lg:flex-wrap lg:items-center lg:gap-2">
        <span className="font-mono text-[10px] text-muted-foreground uppercase lg:hidden">
          Auth
        </span>
        <AuthStatusControl
          busy={props.busy}
          canAuthorize={canAuthorize}
          onAuthorize={props.onAuthorize}
          status={props.authStatus}
        />
      </div>
    </div>
  );
}

function ToolCountLabel(props: { usage?: ServerToolTokenEstimate }) {
  if (!props.usage) {
    return <span className="block min-w-0 font-mono text-xs text-muted-foreground">N/A</span>;
  }
  return (
    <span className="block min-w-0" title="Estimated from the latest Ratel telemetry">
      <span className="block truncate font-mono text-xs">
        {formatToolCount(props.usage.toolCount)}
      </span>
    </span>
  );
}

function formatScopeTokenSummary(input: {
  estimatedTokens: number;
  measuredSourceCount: number;
  sourceCount: number;
  toolCount: number;
}): string {
  if (input.sourceCount === 0) return "No tool sources in this scope";
  if (input.measuredSourceCount === 0) {
    return "Use Ratel Local to estimate tool counts and token savings";
  }
  return `${formatToolCount(input.toolCount)} in this scope, estimated to save ~${formatTokenEstimate(
    input.estimatedTokens,
  )}`;
}

function formatToolCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  return `${value} ${value === 1 ? "tool" : "tools"}`;
}

function formatTokenEstimate(tokens: number): string {
  const value = Math.max(0, Math.round(tokens));
  if (value >= 1_000_000) return `${trimCompactNumber(value / 1_000_000)}M tokens`;
  if (value >= 1_000) return `${trimCompactNumber(value / 1_000)}k tokens`;
  return `${value} tokens`;
}

function trimCompactNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function expectedRevision(config: ConfigResponse, scope: RatelScope): string | undefined {
  return config.documents?.find(({ ref }) => ref.scope === scope)?.documentRevision;
}

function ToolSourceFilterSelect(props: {
  children: ReactNode;
  label: string;
  onValueChange: (value: string) => void;
  value: string;
  valueLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <DetailLabel>{props.label}</DetailLabel>
      <Select value={props.value} onValueChange={props.onValueChange}>
        <SelectTrigger className="h-8 min-w-0 flex-1 bg-background px-2.5 text-xs sm:min-w-32">
          <SelectValue>{props.valueLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>{props.children}</SelectContent>
      </Select>
    </div>
  );
}

export function ToolSourceCreatePage(props: { scope: string }) {
  const navigate = useNavigate();
  const { config, context, pagePath, request, runAction, token } = useRatelApp();
  const requestedScope = isRatelScope(props.scope) ? props.scope : "user";
  const scope = context.kind === "project" ? requestedScope : "user";
  const scopeData = config?.scopes[scope];
  const backPath = pagePath("/");

  const goBack = () => {
    void navigate({ to: backPath } as never);
  };

  const addEntry = async (name: string, entry: ServerEntry) => {
    if (!config) throw new Error("Ratel configuration is not loaded");
    const saved = await runAction(`Added ${name}`, () =>
      request("/api/servers", {
        method: "POST",
        body: {
          target: scopeTarget(context, scope),
          scope,
          name,
          entry,
          expectedRevision: expectedRevision(config, scope),
        },
      }),
    );
    if (saved) {
      void navigate({ to: toolSourcePath(scope, name, token, context) } as never);
    }
  };

  if (!config) {
    return (
      <ToolDetailShell onBack={goBack} title="Add tool source">
        <p className="text-sm text-muted-foreground">Reading the current Ratel configuration.</p>
      </ToolDetailShell>
    );
  }

  if (!scopeData?.available) {
    return (
      <ToolDetailShell onBack={goBack} title="Scope unavailable">
        <p className="text-sm text-muted-foreground">
          Ratel could not resolve the {scope} config scope in the current working directory.
        </p>
      </ToolDetailShell>
    );
  }

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="lg:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Tool Sources
            </Button>
          </PageHeaderBackRow>
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant="outline">MCP</Badge>
            <Badge className="font-mono" variant="secondary">
              {scope}
            </Badge>
            <PageHeaderTitle className="truncate text-2xl">Add tool source</PageHeaderTitle>
          </div>
          <PageHeaderDescription className="mt-2">
            Create a new MCP tool source in the {scope} scope.
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>

      <section className="rounded-2xl border border-forest-300 bg-forest-600/40 p-5 sm:p-6">
        <EntryForm layout="page" onCancel={goBack} onSubmit={addEntry} />
      </section>
    </main>
  );
}

export function ToolSourceDetailPage(props: { name: string; scope: string }) {
  const navigate = useNavigate();
  const { busy, config, context, pagePath, request, runAction } = useRatelApp();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const parsedScope = isRatelScope(props.scope) ? props.scope : null;
  const scope = context.kind === "project" || parsedScope === "user" ? parsedScope : null;
  const scopeData = scope ? config?.scopes[scope] : undefined;
  const entry = scopeData?.available ? scopeData.config.mcpServers[props.name] : undefined;
  const authStatus = scopeData?.available ? scopeData.authStatus[props.name] : undefined;
  const backPath = pagePath("/");

  const goBack = () => {
    void navigate({ to: backPath } as never);
  };

  if (!config) {
    return (
      <ToolDetailShell onBack={goBack} title="Loading tool source">
        <p className="text-sm text-muted-foreground">Reading the current Ratel configuration.</p>
      </ToolDetailShell>
    );
  }

  if (!scope || !scopeData?.available || !entry) {
    return (
      <ToolDetailShell onBack={goBack} title="Tool source not found">
        <p className="text-sm text-muted-foreground">
          This MCP source is not available in the current Ratel configuration.
        </p>
      </ToolDetailShell>
    );
  }

  const code = JSON.stringify({ [props.name]: entry }, null, 2);
  const type = entryTypeOf(entry);
  const target = summaryOf(entry);
  const canAuthorize =
    (entry.type === "http" || entry.type === "sse") &&
    (authStatus === "needs auth" || authStatus === "expired");
  const editFormId = `tool-source-edit-${scope}-${props.name}`;

  const authorize = () =>
    runAction("Authorization updated", () =>
      request(`/api/auth/${encodeURIComponent(props.name)}`, {
        method: "POST",
        body: {},
      }),
    );

  const updateEntry = async (_name: string, nextEntry: ServerEntry) => {
    await runAction(`Updated ${props.name}`, () =>
      request(`/api/servers/${encodeURIComponent(props.name)}`, {
        method: "PATCH",
        body: {
          entry: nextEntry,
          target: scopeTarget(context, scope),
          scope,
          expectedRevision: expectedRevision(config, scope),
        },
      }),
    );
    setIsEditing(false);
  };

  const removeEntry = async () => {
    await runAction(`Removed ${props.name}`, () =>
      request(`/api/servers/${encodeURIComponent(props.name)}`, {
        method: "DELETE",
        body: {
          target: scopeTarget(context, scope),
          scope,
          expectedRevision: expectedRevision(config, scope),
        },
      }),
    );
    setDeleteOpen(false);
    goBack();
  };

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <PageHeaderContent>
            <PageHeaderBackRow>
              <Button onClick={goBack} size="sm" type="button" variant="ghost">
                <ArrowLeft />
                Tool Sources
              </Button>
              <div className="flex items-center gap-1 sm:hidden">
                <ButtonGroup>
                  {isEditing ? (
                    <>
                      <Button
                        aria-label="Cancel"
                        onClick={() => setIsEditing(false)}
                        size="icon-lg"
                        type="button"
                        variant="outline"
                      >
                        <X />
                        <span className="sr-only">Cancel</span>
                      </Button>
                      <Button aria-label="Save" form={editFormId} size="icon-lg" type="submit">
                        <Save />
                        <span className="sr-only">Save</span>
                      </Button>
                    </>
                  ) : (
                    <Button
                      aria-label="Edit"
                      onClick={() => setIsEditing(true)}
                      size="icon-lg"
                      type="button"
                      variant="outline"
                    >
                      <Pencil />
                      <span className="sr-only">Edit</span>
                    </Button>
                  )}
                  <Button
                    aria-label="Remove"
                    disabled={busy}
                    onClick={() => setDeleteOpen(true)}
                    size="icon-lg"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 />
                    <span className="sr-only">Remove</span>
                  </Button>
                </ButtonGroup>
              </div>
            </PageHeaderBackRow>
            <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
              <PageHeaderTitle className="truncate text-2xl">{props.name}</PageHeaderTitle>
              <Badge variant="outline">MCP</Badge>
            </div>
            <PageHeaderDescription className="mt-2">
              {entry.description || "No description stored for this tool source."}
            </PageHeaderDescription>
          </PageHeaderContent>

          <PageHeaderActions className="hidden sm:flex">
            <ResponsiveToolbar>
              <ResponsiveToolbarGroup>
                {isEditing ? (
                  <>
                    <ResponsiveToolbarLabeledButton
                      icon={<X />}
                      label="Cancel"
                      onClick={() => setIsEditing(false)}
                      type="button"
                    />
                    <ResponsiveToolbarLabeledButton
                      form={editFormId}
                      icon={<Save />}
                      label="Save"
                      type="submit"
                      variant="default"
                    />
                  </>
                ) : (
                  <ResponsiveToolbarLabeledButton
                    icon={<Pencil />}
                    label="Edit"
                    onClick={() => setIsEditing(true)}
                    type="button"
                  />
                )}
                <ResponsiveToolbarLabeledButton
                  className="border-destructive/25"
                  disabled={busy}
                  icon={<Trash2 />}
                  label="Remove"
                  onClick={() => setDeleteOpen(true)}
                  type="button"
                  variant="destructive"
                />
              </ResponsiveToolbarGroup>
            </ResponsiveToolbar>
          </PageHeaderActions>
        </PageHeader>

        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="text-destructive">
              <Trash2 />
            </AlertDialogMedia>
            <AlertDialogTitle>Remove tool source</AlertDialogTitle>
            <AlertDialogDescription>
              Would you like to remove <strong>{props.name}</strong> from the tool sources of the{" "}
              <Badge className="inline-flex align-baseline font-mono" variant="secondary">
                {scope}
              </Badge>
              ?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void removeEntry()}
              variant="destructive"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isEditing ? (
        <section className="rounded-2xl border border-forest-300 bg-forest-600/40 p-5 sm:p-6">
          <EntryForm
            entry={entry}
            formId={editFormId}
            layout="page"
            name={props.name}
            onCancel={() => setIsEditing(false)}
            onSubmit={updateEntry}
          />
        </section>
      ) : (
        <section className="grid gap-5">
          <DetailGrid>
            <DetailLabel>Scope</DetailLabel>
            <Badge className="w-fit font-mono" variant="secondary">
              {scope}
            </Badge>
            <DetailLabel>Transport</DetailLabel>
            <Badge className="w-fit font-mono" variant="secondary">
              {toolSourceTypeLabel(type)}
            </Badge>
            <DetailLabel>Target</DetailLabel>
            <code className="min-w-0 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {target}
            </code>
            <DetailLabel>Auth</DetailLabel>
            <div className="flex flex-wrap items-center gap-2">
              <AuthStatusControl
                busy={busy}
                canAuthorize={canAuthorize}
                onAuthorize={authorize}
                status={authStatus}
              />
            </div>
            <DetailLabel>Description</DetailLabel>
            <p className="min-w-0 text-sm text-muted-foreground">
              {entry.description || "No description stored."}
            </p>
          </DetailGrid>

          <CodeBlock code={code} label="config.json" />
        </section>
      )}
    </main>
  );
}

function ToolDetailShell(props: { children: ReactNode; onBack: () => void; title: string }) {
  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="lg:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={props.onBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Tool Sources
            </Button>
          </PageHeaderBackRow>
          <PageHeaderTitle className="mt-4 text-2xl">{props.title}</PageHeaderTitle>
        </PageHeaderContent>
      </PageHeader>
      {props.children}
    </main>
  );
}

function isRatelScope(value: string): value is RatelScope {
  return SCOPES.includes(value as RatelScope);
}

function scopeLabel(scope: RatelScope): string {
  return scope[0].toUpperCase() + scope.slice(1);
}

function EntryForm(props: {
  entry?: ServerEntry;
  formId?: string;
  layout?: "drawer" | "page";
  name?: string;
  onCancel: () => void;
  onSubmit: (name: string, entry: ServerEntry) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const formClassName =
    props.layout === "page"
      ? "grid gap-6"
      : "mt-4 grid max-h-[min(72vh,680px)] gap-6 overflow-y-auto px-1.5 pb-1.5 scroll-mask-y scroll-mask-y-from-88%";
  const actionClassName =
    props.layout === "page"
      ? "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"
      : "grid gap-2 border-border border-t pt-4 sm:grid-cols-2";
  const form = useForm({
    defaultValues: entryFormDefaults(props.name, props.entry),
    validators: {
      onSubmit: entryFormSchema,
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const { entry, name } = entrySubmitSchema.parse(value);
        await props.onSubmit(name, entry);
      } catch (err) {
        setError((err as Error).message);
      }
    },
  });

  return (
    <form
      data-vaul-no-drag=""
      className={formClassName}
      id={props.formId}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup className="gap-6">
        <FieldSet>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            <form.Field name="name">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      autoComplete="off"
                      className={ENTRY_INPUT_CLASS}
                      disabled={Boolean(props.name)}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="linear"
                      value={field.state.value}
                    />
                    <FieldDescription>Unique key in the selected Ratel scope.</FieldDescription>
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>
            <form.Field name="type">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>Transport</FieldLabel>
                    <Select
                      name={field.name}
                      onValueChange={(value) => {
                        if (isEntryType(value)) field.handleChange(value);
                      }}
                      value={field.state.value}
                    >
                      <SelectTrigger
                        aria-invalid={isInvalid}
                        className="w-full bg-background"
                        id={field.name}
                        onBlur={field.handleBlur}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stdio">stdio</SelectItem>
                        <SelectItem value="http">http</SelectItem>
                        <SelectItem value="sse">sse</SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>How the MCP source is reached.</FieldDescription>
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
            <form.Field name="description">
              {(field) => {
                const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                return (
                  <Field data-invalid={isInvalid} className="md:col-span-2">
                    <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      className={ENTRY_INPUT_CLASS}
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      placeholder="What this source gives the agent access to"
                      value={field.state.value}
                    />
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                );
              }}
            </form.Field>
          </div>
        </FieldSet>

        <form.Subscribe selector={(state) => state.values.type}>
          {(type) =>
            type === "stdio" ? (
              <FieldSet className="border-border border-t pt-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <form.Field name="command">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Command</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            autoComplete="off"
                            className={ENTRY_INPUT_CLASS}
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder="uvx"
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="cwd">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Working directory</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            autoComplete="off"
                            className={ENTRY_INPUT_CLASS}
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder="/Users/me/project"
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="args" mode="array">
                    {(field) => (
                      <Field className="md:col-span-2">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <FieldLabel>Arguments</FieldLabel>
                            <FieldDescription>One command argument per row.</FieldDescription>
                          </div>
                          <Button
                            onClick={() => field.pushValue(newArgumentFormRow())}
                            size="sm"
                            type="button"
                            variant="outline"
                          >
                            <Plus />
                            Add argument
                          </Button>
                        </div>
                        <div className="grid gap-2">
                          {field.state.value.map((item, index) => (
                            <form.Field key={item.id} name={`args[${index}].value` as const}>
                              {(argField) => (
                                <ButtonGroup className="w-full">
                                  <Input
                                    aria-label={`Argument ${index + 1}`}
                                    autoComplete="off"
                                    className={cn(ENTRY_INPUT_CLASS, "font-mono")}
                                    id={argField.name}
                                    name={argField.name}
                                    onBlur={argField.handleBlur}
                                    onChange={(event) => argField.handleChange(event.target.value)}
                                    placeholder={index === 0 ? "blender-mcp" : "--verbose"}
                                    value={argField.state.value}
                                  />
                                  <Button
                                    aria-label={`Remove argument ${index + 1}`}
                                    className="px-3"
                                    onClick={() => {
                                      if (field.state.value.length === 1) {
                                        field.replaceValue(index, newArgumentFormRow());
                                      } else {
                                        field.removeValue(index);
                                      }
                                    }}
                                    size="lg"
                                    type="button"
                                    variant="outline"
                                  >
                                    <Trash2 />
                                  </Button>
                                </ButtonGroup>
                              )}
                            </form.Field>
                          ))}
                        </div>
                      </Field>
                    )}
                  </form.Field>
                  <form.Field name="env">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid} className="md:col-span-2">
                          <FieldLabel htmlFor={field.name}>Environment</FieldLabel>
                          <Textarea
                            aria-invalid={isInvalid}
                            className={cn(ENTRY_TEXTAREA_CLASS, "resize-none")}
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder={"GITHUB_TOKEN=ghp_...\nFIGMA_TOKEN=figd_..."}
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                </div>
              </FieldSet>
            ) : (
              <FieldSet className="border-border border-t pt-5">
                <FieldDescription>
                  Configure the URL and optional request metadata for this remote MCP source.
                </FieldDescription>
                <form.Field name="url">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>URL</FieldLabel>
                        <Input
                          aria-invalid={isInvalid}
                          autoComplete="url"
                          className={ENTRY_INPUT_CLASS}
                          id={field.name}
                          name={field.name}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                          placeholder="https://mcp.example.com/mcp"
                          value={field.state.value}
                        />
                        {isInvalid && <FieldError errors={field.state.meta.errors} />}
                      </Field>
                    );
                  }}
                </form.Field>
                <form.Field name="headers">
                  {(field) => {
                    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                    return (
                      <Field data-invalid={isInvalid}>
                        <FieldLabel htmlFor={field.name}>Headers</FieldLabel>
                        <InputGroup>
                          <InputGroupTextarea
                            aria-invalid={isInvalid}
                            className={cn(ENTRY_TEXTAREA_CLASS, "resize-none")}
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder={"Authorization: Bearer token\nX-Team: platform"}
                            value={field.state.value}
                          />
                        </InputGroup>
                        {isInvalid && <FieldError errors={field.state.meta.errors} />}
                      </Field>
                    );
                  }}
                </form.Field>
              </FieldSet>
            )
          }
        </form.Subscribe>

        <form.Subscribe selector={(state) => state.values.type}>
          {(type) =>
            type === "stdio" ? null : (
              <FieldSet className="border-border border-t pt-5">
                <FieldDescription>
                  Optional OAuth client metadata for protected endpoints.
                </FieldDescription>
                <div className="grid gap-4 md:grid-cols-2">
                  <form.Field name="clientId">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Client ID</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            autoComplete="off"
                            className={ENTRY_INPUT_CLASS}
                            placeholder="client_abc123"
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="clientSecret">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Client secret</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            autoComplete="off"
                            className={ENTRY_INPUT_CLASS}
                            placeholder="••••••••••••"
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            type="password"
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="callbackPort">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Callback port</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            className={ENTRY_INPUT_CLASS}
                            id={field.name}
                            inputMode="numeric"
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder="3333"
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                  <form.Field name="oauthScope">
                    {(field) => {
                      const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>Scope</FieldLabel>
                          <Input
                            aria-invalid={isInvalid}
                            autoComplete="off"
                            className={ENTRY_INPUT_CLASS}
                            id={field.name}
                            name={field.name}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                            placeholder="read:files write:comments"
                            value={field.state.value}
                          />
                          {isInvalid && <FieldError errors={field.state.meta.errors} />}
                        </Field>
                      );
                    }}
                  </form.Field>
                </div>
              </FieldSet>
            )
          }
        </form.Subscribe>
      </FieldGroup>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not save tool source</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className={actionClassName}>
        <Button
          className={props.layout === "page" ? "sm:min-w-32" : undefined}
          onClick={props.onCancel}
          size={props.layout === "page" ? "lg" : "default"}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          className={props.layout === "page" ? "sm:min-w-40" : undefined}
          size={props.layout === "page" ? "lg" : "default"}
          type="submit"
        >
          {props.name ? "Save changes" : "Add source"}
        </Button>
      </div>
    </form>
  );
}

function entryFormDefaults(
  name: string | undefined,
  entry: ServerEntry | undefined,
): EntryFormValues {
  return {
    args: entry?.args?.length
      ? entry.args.map((value) => newArgumentFormRow(value))
      : [newArgumentFormRow()],
    callbackPort: entry?.callbackPort === undefined ? "" : String(entry.callbackPort),
    clientId: entry?.clientId ?? "",
    clientSecret: entry?.clientSecret ?? "",
    command: entry?.command ?? "",
    cwd: entry?.cwd ?? "",
    description: entry?.description ?? "",
    env: keyValsToText(entry?.env, "="),
    headers: keyValsToText(entry?.headers, ": "),
    name: name ?? "",
    oauthScope: entry?.scope ?? "",
    type: isEntryType(entry?.type) ? entry.type : "stdio",
    url: entry?.url ?? "",
  };
}

let argumentFormRowId = 0;

function newArgumentFormRow(value = ""): ArgumentFormRow {
  argumentFormRowId += 1;
  return { id: `arg-${argumentFormRowId}`, value };
}

function isEntryType(value: unknown): value is EntryType {
  return value === "stdio" || value === "http" || value === "sse";
}

function entryTypeOf(entry: ServerEntry): EntryType {
  return isEntryType(entry.type) ? entry.type : "stdio";
}

function authStatusOf(status: AuthStatus | undefined): AuthStatus {
  return status ?? "n/a";
}

function compactEntry(entry: ServerEntry): ServerEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as ServerEntry;
}

function AuthBadge({ status }: { status?: AuthStatus }) {
  const resolvedStatus = authStatusOf(status);
  if (resolvedStatus === "n/a") {
    return (
      <span className="text-xs text-muted-foreground">{getAuthStatusLabel(resolvedStatus)}</span>
    );
  }
  return (
    <Badge className="w-fit" variant={authBadgeVariant(resolvedStatus)}>
      {getAuthStatusLabel(resolvedStatus)}
    </Badge>
  );
}

function AuthStatusControl(props: {
  busy: boolean;
  canAuthorize: boolean;
  onAuthorize: () => Promise<unknown> | undefined;
  status?: AuthStatus;
}) {
  const [authorizing, setAuthorizing] = useState(false);
  const handleAuthorize = async () => {
    setAuthorizing(true);
    try {
      await props.onAuthorize();
    } finally {
      setAuthorizing(false);
    }
  };

  if (!props.canAuthorize) {
    return <AuthBadge status={props.status} />;
  }

  const disabled = props.busy || authorizing;

  return (
    <ButtonGroup className="w-fit">
      <ButtonGroupText className={authControlTextClassName(props.status)}>
        {authStatusLabel(props.status)}
      </ButtonGroupText>
      <Button
        aria-label={props.status === "expired" ? "Reauthorize" : "Authorize"}
        className={authControlButtonClassName(props.status)}
        disabled={disabled}
        onClick={() => void handleAuthorize()}
        size="icon-xs"
        title={props.status === "expired" ? "Reauthorize" : "Authorize"}
        variant="outline"
      >
        {authorizing ? <Spinner /> : <ExternalLink />}
      </Button>
    </ButtonGroup>
  );
}

function authStatusLabel(status?: AuthStatus) {
  return getAuthStatusLabel(authStatusOf(status));
}

function authControlTextClassName(status?: AuthStatus) {
  return cn(
    "h-6 px-2 text-[11px] leading-none font-medium shadow-none",
    status === "needs auth" &&
      "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200",
    status === "expired" && "border-border bg-muted text-muted-foreground",
    status === "unsupported" &&
      "border-destructive/30 bg-destructive/10 text-destructive dark:bg-destructive/15",
    (!status || status === "n/a" || status === "ok") &&
      "border-border bg-background text-foreground",
  );
}

function authControlButtonClassName(status?: AuthStatus) {
  return cn(
    "h-6 w-7 shadow-none [&_svg:not([class*='size-'])]:size-3.5",
    status === "needs auth" &&
      "border-amber-300/70 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200 dark:hover:bg-amber-500/20",
    status === "expired" && "border-border bg-muted text-muted-foreground hover:bg-muted/80",
  );
}

function EmptyTools(props: { action: ReactNode; children: ReactNode; title: string }) {
  return (
    <section className="grid min-h-64 place-items-center rounded-2xl border border-forest-300 border-dashed bg-forest-600/20 px-6 py-8 text-center">
      <div className="grid max-w-md gap-3">
        <EmptyStateIcon>
          <Server className="size-5" />
        </EmptyStateIcon>
        <div>
          <h3 className="font-medium">{props.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{props.children}</p>
        </div>
        <div>{props.action}</div>
      </div>
    </section>
  );
}
