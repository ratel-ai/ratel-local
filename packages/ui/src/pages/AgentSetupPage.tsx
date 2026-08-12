import {
  type AgentImportWorkflowState,
  advanceAgentImportWorkflow,
  beginAgentImportWorkflow,
  unlinkedAgentImportWarning,
} from "@ratel-ai/ratel-local-core/agent-import-workflow";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type StructuredPatchHunk, structuredPatch } from "diff";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  FileText,
  GitCompare,
  LinkIcon,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useMeasure from "react-use-measure";
import { type JsonRequestInit, type ServerEntry, useRatelApp } from "@/App";
import { SkillImportPicker, skillKey } from "@/components/import-skills-dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { PageSurface, PageSurfaceContent, PageSurfaceFooter } from "@/components/page-surface";
import {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
} from "@/components/responsive-toolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DetailGrid, DetailLabel } from "@/components/ui/detail-grid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { importStatuslineAction, linkThenRefreshImportPreview } from "@/lib/agent-import-flow";
import { REFRESH_SHORTCUT } from "@/lib/keyboard-shortcuts";
import { ratelApiQueryOptions, ratelQueryKeys } from "@/lib/ratel-query";
import {
  applySkillImportSelections,
  availableSkillsForKind,
  buildSkillImportSelections,
  defaultSkillImportTarget,
  discoveredSkillSummaries,
  type SkillSummary,
  type SkillsResponse,
  uniqueSkillImports,
} from "@/lib/skills";
import { useRatelMutation } from "@/lib/use-ratel-mutation";
import { cn } from "@/lib/utils";

type AgentHostKind = "claude-code" | "codex";
type AgentScope = "user" | "project" | "local";
type AgentPosture = "unavailable" | "empty" | "not-linked" | "ratel-only" | "mixed";
type RatelConnectionKind = "none" | "explicit" | "plugin" | "duplicate";
type ConflictStrategy = "add-missing-only" | "replace-from-agent" | "replace-selected";
type SetupFlow = "import" | "link";

interface AgentHostDetection {
  displayName: string;
  present: boolean;
  reasons: string[];
  warnings: string[];
}

interface AgentScopePosture {
  scope: AgentScope;
  displayName: string;
  path: string;
  available: boolean;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames?: string[];
  ratelEntryNames?: string[];
}

interface ClaudeStatuslineState {
  settingsPath: string;
  status: "not-installed" | "installed" | "other";
  installed: boolean;
  ownedByRatel: boolean;
  command: string | null;
  ratelEnabled: boolean;
  ratelEnabledSources: string[];
  warnings: string[];
}

interface RatelConnectionState {
  kind: RatelConnectionKind;
  linked: boolean;
  explicit: boolean;
  plugin: boolean;
}

export interface DetectedAgentHostSummary {
  kind: AgentHostKind;
  displayName: string;
  detection: AgentHostDetection;
  connection: RatelConnectionState;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames?: string[];
  ratelEntryNames?: string[];
  missingRatelEntryNames?: string[];
  scopes: AgentScopePosture[];
  statusline?: ClaudeStatuslineState;
}

interface AgentHostsResponse {
  hosts: DetectedAgentHostSummary[];
}

type AgentTraceState = "disabled" | "configured" | "stale" | "conflict" | "invalid";
type AgentTraceLevel =
  | "off"
  | "redacted"
  | "tool-details"
  | "full-content"
  | "tool-activity"
  | "prompt-content";
type AgentTraceObservedLevel = AgentTraceLevel | "custom" | "unknown";

interface AgentTraceHostStatus {
  hostKind: AgentHostKind;
  displayName: string;
  configPath: string;
  state: AgentTraceState;
  level: AgentTraceObservedLevel;
  supportedLevels: AgentTraceLevel[];
  signals?: {
    traces: "disabled" | "configured" | "stale" | "conflict";
    logs: "disabled" | "configured" | "stale" | "conflict";
  };
  restartRequired: boolean;
  conflictingFields: string[];
  warnings: string[];
}

interface AgentTracesResponse {
  endpoint: string;
  logsEndpoint?: string;
  cloudConfigured: boolean;
  hosts: AgentTraceHostStatus[];
}

interface PreparedAgentTraceResponse {
  changeId: string;
}

interface CloudTraceSettingsStatus {
  configured: boolean;
  endpoint: string;
}

export function cloudTraceSetupPatch(
  endpoint: string,
  apiKey: string,
): { endpoint: string; apiKey: string } {
  const normalizedEndpoint = endpoint.trim();
  const normalizedApiKey = apiKey.trim();
  if (!normalizedEndpoint) throw new Error("Ratel Cloud trace endpoint is unavailable");
  if (!normalizedApiKey) throw new Error("Ratel Cloud API key is required");
  return { endpoint: normalizedEndpoint, apiKey: normalizedApiKey };
}

export function agentHostsFromResponse(body: unknown): DetectedAgentHostSummary[] {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as AgentHostsResponse).hosts)
  ) {
    return (body as AgentHostsResponse).hosts;
  }
  return [];
}

interface AgentCandidate {
  name: string;
  scope: AgentScope;
  entry: ServerEntry;
}

interface PlannedFileWrite {
  path: string;
  before: string | null;
  after: string;
}

interface ImportConflict {
  name: string;
  scope: AgentScope;
  incoming: ServerEntry;
  existing: ServerEntry;
}

interface AgentPlanPreview {
  changeId: string;
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  candidates: AgentCandidate[];
  selected: string[];
  plan: {
    ratelChanges: PlannedFileWrite[];
    agentChanges: PlannedFileWrite[];
    summary: {
      movedFromUser: string[];
      movedFromProject: string[];
      movedFromLocal: string[];
      replacedFromUser: string[];
      replacedFromProject: string[];
      replacedFromLocal: string[];
      skipped: Array<{ name: string; scope: AgentScope; reason: string }>;
      conflicts: ImportConflict[];
      conflictStrategy: ConflictStrategy;
      overwrittenRatelEntries: AgentScope[];
    };
  };
  emptyReason: string | null;
}

interface PreparedAgentChangeResponse {
  changeId: string;
  kind: string;
  expiresAt: string;
  preview: Omit<AgentPlanPreview, "changeId">;
}

function useAgentAction() {
  const { context } = useRatelApp();
  const mutation = useRatelMutation<unknown, { action: () => Promise<unknown>; label: string }>({
    invalidate: [ratelQueryKeys.config(context)],
    mutationFn: ({ action }) => action(),
    successMessage: (_data, { label }) => label,
  });
  return {
    isPending: mutation.isPending,
    runAction: async (label: string, action: () => Promise<unknown>) => {
      try {
        await mutation.mutateAsync({ action, label });
        return true;
      } catch {
        return false;
      }
    },
  };
}

function agentPreviewFromPrepared(change: PreparedAgentChangeResponse): AgentPlanPreview {
  return { ...change.preview, changeId: change.changeId };
}

const POSTURE_COPY: Record<
  AgentPosture,
  { label: string; tone: "default" | "secondary" | "outline"; description: string }
> = {
  unavailable: {
    label: "Unavailable",
    tone: "outline",
    description: "No config file found at known paths.",
  },
  empty: {
    label: "Empty",
    tone: "secondary",
    description: "Config exists but has no MCP entries.",
  },
  "not-linked": {
    label: "Not linked",
    tone: "default",
    description: "Native MCP entries exist without Ratel.",
  },
  "ratel-only": {
    label: "Ratel only",
    tone: "secondary",
    description: "Ratel is connected with no native MCP entries.",
  },
  mixed: {
    label: "Mixed",
    tone: "default",
    description: "Native MCP entries exist alongside a Ratel connection.",
  },
};

const CODEX_ICON_SRC = new URL("../assets/codex-color.svg", import.meta.url).href;
const CLAUDE_CODE_ICON_SRC = new URL("../assets/claudecode-color.svg", import.meta.url).href;

/**
 * Load the unmanaged skills available across agents (those Ratel doesn't manage
 * yet). Shared by the agent directory (for per-card counts) and the agent detail
 * page (for the import section). Fail-soft to an empty list so a skills hiccup
 * never blocks the MCP setup flows.
 */
function useAvailableSkills(initialAvailable?: SkillSummary[]) {
  const { context, token } = useRatelApp();
  const query = useQuery(
    ratelApiQueryOptions<SkillsResponse>({
      context,
      path: "/api/skills",
      queryKey: ratelQueryKeys.skills(context),
      token,
    }),
  );
  return {
    available: query.data ? discoveredSkillSummaries(query.data) : (initialAvailable ?? []),
    reload: async () => {
      await query.refetch();
    },
  };
}

function useAgentHosts(initialHosts?: DetectedAgentHostSummary[]) {
  const { context, token } = useRatelApp();
  const query = useQuery(
    ratelApiQueryOptions<unknown>({
      context,
      path: "/api/agent-hosts",
      queryKey: ratelQueryKeys.agentHosts(context),
      token,
    }),
  );
  return {
    hosts: query.data ? agentHostsFromResponse(query.data) : (initialHosts ?? []),
    scanHosts: async () => {
      await query.refetch();
    },
    scanning: query.isFetching,
  };
}

function useAgentTraces() {
  const { context, token } = useRatelApp();
  const query = useQuery(
    ratelApiQueryOptions<AgentTracesResponse>({
      context,
      path: "/api/agent-traces",
      queryKey: ratelQueryKeys.agentTraces(),
      token,
    }),
  );
  return {
    status: query.data,
    reload: async () => {
      await query.refetch();
    },
  };
}

export interface AgentSetupRouteData {
  available: SkillSummary[];
  hosts: DetectedAgentHostSummary[];
}

export function AgentSettingsSection({ initialData }: { initialData?: AgentSetupRouteData }) {
  const { clearSetupIntent, pagePath, refresh, setupIntent } = useRatelApp();
  const navigate = useNavigate();
  const { available } = useAvailableSkills(initialData?.available);
  const { hosts, scanHosts, scanning } = useAgentHosts(initialData?.hosts);
  const handledIntent = useRef<number | null>(null);
  const openAgent = useCallback(
    (kind: AgentHostKind, operation?: SetupFlow) => {
      const path = pagePath(`/agent-setup/${kind}`);
      const separator = path.includes("?") ? "&" : "?";
      void navigate({
        to: operation ? `${path}${separator}operation=${operation}` : path,
      } as never);
    },
    [navigate, pagePath],
  );

  useEffect(() => {
    if (setupIntent && handledIntent.current !== setupIntent.id) {
      handledIntent.current = setupIntent.id;
      openAgent(preferredHostKind(hosts), setupIntent.kind);
      clearSetupIntent();
    }
  }, [clearSetupIntent, hosts, openAgent, setupIntent]);

  return (
    <section aria-labelledby="agents-settings-title" className="grid gap-3">
      <div className="flex items-end justify-between gap-3 px-1">
        <div>
          <h2 className="text-lg font-semibold" id="agents-settings-title">
            Agents
          </h2>
          <p className="text-sm text-muted-foreground">
            Connections and native integrations for Claude Code and Codex.
          </p>
        </div>
        <Button
          aria-label="Refresh agents"
          disabled={scanning}
          onClick={() => void Promise.all([refresh(), scanHosts()])}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw />
          Refresh
          {scanning ? <Button.LoadingIndicator label="Refreshing agents" /> : null}
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {hosts.map((host) => (
          <AgentDirectoryCard
            host={host}
            key={host.kind}
            onOpen={() => openAgent(host.kind)}
            unmanagedSkillCount={availableSkillsForKind(available, host.kind).length}
          />
        ))}
      </div>
    </section>
  );
}

export function LegacyAgentSetupRedirect() {
  const { pagePath } = useRatelApp();
  const navigate = useNavigate();

  useEffect(() => {
    void navigate({ replace: true, to: pagePath("/settings") } as never);
  }, [navigate, pagePath]);

  return (
    <main className="grid min-h-48 place-items-center px-6 text-sm text-muted-foreground">
      Opening agent settings…
    </main>
  );
}

export function AgentDetailPage(props: {
  initialData?: AgentSetupRouteData;
  kind: AgentHostKind;
  operation?: SetupFlow;
}) {
  const { pagePath, refresh, request } = useRatelApp();
  const navigate = useNavigate();
  const { available, reload: reloadSkills } = useAvailableSkills(props.initialData?.available);
  const agentAvailable = availableSkillsForKind(available, props.kind);
  const { hosts, scanHosts, scanning } = useAgentHosts(props.initialData?.hosts);
  const agentTraces = useAgentTraces();

  const host = hosts.find((item) => item.kind === props.kind);
  const goBack = () => {
    void navigate({ to: pagePath("/settings") } as never);
  };
  const switchHost = (kind: AgentHostKind) => {
    void navigate({ to: pagePath(`/agent-setup/${kind}`) } as never);
  };
  const primaryPath = host?.scopes.find((scope) => scope.available)?.path ?? host?.scopes[0]?.path;

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Settings
            </Button>
            <div className="flex items-center gap-1 sm:hidden">
              <Button
                aria-label="Refresh"
                disabled={scanning}
                onClick={() => void Promise.all([refresh(), scanHosts()])}
                size="icon-lg"
                type="button"
                variant="outline"
              >
                <RefreshCw />
                {scanning && <Button.LoadingIndicator label="Refreshing agent setup" />}
                <span className="sr-only">Refresh</span>
              </Button>
            </div>
          </PageHeaderBackRow>
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
            <PageHeaderTitle className="truncate text-2xl">
              {host?.displayName ?? agentDisplayName(props.kind)}
            </PageHeaderTitle>
          </div>
          <PageHeaderDescription className="mt-2">
            {host
              ? POSTURE_COPY[host.posture].description
              : "Reading the supported agent configuration."}
          </PageHeaderDescription>
          {host ? (
            <AgentPageSwitcher
              className="mt-4 w-full sm:hidden"
              currentKind={host.kind}
              hosts={hosts}
              onHostKindChange={switchHost}
            />
          ) : null}
        </PageHeaderContent>

        <PageHeaderActions className="hidden sm:flex">
          <ResponsiveToolbar>
            {host ? (
              <AgentPageSwitcher
                className="min-w-0 flex-1 sm:w-56 sm:flex-none"
                currentKind={host.kind}
                hosts={hosts}
                onHostKindChange={switchHost}
              />
            ) : null}
            <ResponsiveToolbarGroup>
              <ResponsiveToolbarButton
                disabled={scanning}
                icon={
                  <>
                    <RefreshCw />
                    {scanning && <Button.LoadingIndicator label="Refreshing agent setup" />}
                  </>
                }
                shortcut={REFRESH_SHORTCUT.hotkey}
                label="Refresh"
                onClick={() => void Promise.all([refresh(), scanHosts()])}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      {host ? (
        <section className="grid gap-5">
          <DetailGrid className="items-center">
            <DetailLabel>Host</DetailLabel>
            <div className="flex min-h-5 min-w-0 items-center gap-2">
              <AgentIconFrame kind={host.kind} />
              <span className="font-medium">{host.displayName}</span>
            </div>
            <DetailLabel>Status</DetailLabel>
            <AgentStatusSummary host={host} unmanagedSkillCount={agentAvailable.length} />
            {host.kind === "claude-code" && host.statusline ? (
              <>
                <DetailLabel>Statusline</DetailLabel>
                <ClaudeStatuslineStatus state={host.statusline} />
                <DetailLabel>Ratel Local</DetailLabel>
                <AgentStatusText tone={host.statusline.ratelEnabled ? "success" : "warning"}>
                  {host.statusline.ratelEnabled ? "Enabled" : "Not enabled"}
                </AgentStatusText>
              </>
            ) : null}
            <DetailLabel>Config</DetailLabel>
            <code className="flex min-h-5 min-w-0 items-center truncate font-mono text-xs text-muted-foreground">
              {primaryPath ?? "Known paths unavailable"}
            </code>
          </DetailGrid>

          <AgentOperationPanel
            availableSkills={agentAvailable}
            host={host}
            hostKind={host.kind}
            onScanHosts={scanHosts}
            onSkillsImported={reloadSkills}
            request={request}
            traceStatus={agentTraces.status}
            onTraceStatusChanged={agentTraces.reload}
          />
        </section>
      ) : (
        <div className="rounded-md border border-border px-4 py-8 text-sm text-muted-foreground">
          Scanning supported agent configs...
        </div>
      )}
    </main>
  );
}

function AgentPageSwitcher(props: {
  className?: string;
  currentKind: AgentHostKind;
  hosts: DetectedAgentHostSummary[];
  onHostKindChange: (hostKind: AgentHostKind) => void;
}) {
  const currentHost = props.hosts.find((host) => host.kind === props.currentKind);
  return (
    <Select
      onValueChange={(value) => props.onHostKindChange(value as AgentHostKind)}
      value={props.currentKind}
    >
      <SelectTrigger className={cn("w-full bg-background", props.className)}>
        <SelectValue>
          <span className="flex min-w-0 items-center gap-2">
            <AgentIconFrame kind={props.currentKind} />
            <span className="truncate">
              {currentHost?.displayName ?? agentDisplayName(props.currentKind)}
            </span>
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="end"
        alignItemWithTrigger={false}
        className="w-72 min-w-0 max-w-[calc(100vw-2rem)]"
      >
        {props.hosts.map((host) => (
          <SelectItem key={host.kind} value={host.kind}>
            <AgentIconFrame kind={host.kind} />
            <span className="min-w-0 flex-1 truncate">{host.displayName}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentDirectoryCard(props: {
  host: DetectedAgentHostSummary;
  onOpen: () => void;
  unmanagedSkillCount: number;
}) {
  const posture = POSTURE_COPY[props.host.posture];
  const primaryPath =
    props.host.scopes.find((scope) => scope.available)?.path ?? props.host.scopes[0]?.path;
  const configPath = primaryPath ?? props.host.detection.reasons[0] ?? "Known paths unavailable";
  return (
    <PageSurface className="group h-full transition-colors hover:border-foreground/20 hover:bg-muted/20 focus-within:border-ring/50">
      <button
        className="grid h-full w-full min-w-0 grid-rows-[1fr_auto] text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/35"
        onClick={props.onOpen}
        type="button"
      >
        <PageSurfaceContent className="grid min-w-0 content-start gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <AgentIcon kind={props.host.kind} />
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-lg font-semibold tracking-tight">
                {props.host.displayName}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">{posture.description}</p>
            </div>
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </div>
          <AgentStatusSummary
            className="pl-[3.75rem]"
            host={props.host}
            unmanagedSkillCount={props.unmanagedSkillCount}
          />
        </PageSurfaceContent>
        <PageSurfaceFooter className="grid min-w-0 gap-1">
          <span className="font-mono text-[10px] text-muted-foreground uppercase">Config</span>
          <code className="truncate font-mono text-xs text-muted-foreground" title={configPath}>
            {configPath}
          </code>
        </PageSurfaceFooter>
      </button>
    </PageSurface>
  );
}

function AgentStatusSummary(props: {
  className?: string;
  host: DetectedAgentHostSummary;
  unmanagedSkillCount: number;
}) {
  const status = agentCardStatusModel({
    connectionKind: props.host.connection.kind,
    linked: props.host.connection.linked,
    missingToolCount: missingRatelEntryNames(props.host).length,
    posture: props.host.posture,
    unmanagedSkillCount: props.unmanagedSkillCount,
  });
  const connectionTone =
    props.host.connection.kind === "duplicate"
      ? "warning"
      : props.host.connection.linked
        ? "success"
        : "muted";

  return (
    <div
      className={cn(
        "flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs",
        props.className,
      )}
      data-slot="agent-status-summary"
    >
      <AgentStatusText tone={connectionTone}>{status.connectionLabel}</AgentStatusText>
      <span aria-hidden="true" className="text-border">
        ·
      </span>
      <AgentStatusText dot={false} tone={status.tone}>
        {status.healthLabel}
      </AgentStatusText>
    </div>
  );
}

function AgentStatusText(props: {
  children: React.ReactNode;
  dot?: boolean;
  tone: "muted" | "success" | "warning";
}) {
  const dotClass =
    props.tone === "success"
      ? "bg-emerald-500"
      : props.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground/50";
  return (
    <span
      className={cn(
        "inline-flex min-h-5 items-center gap-1.5 text-xs",
        props.tone === "success" && "text-emerald-700 dark:text-emerald-300",
        props.tone === "warning" && "text-amber-700 dark:text-amber-300",
        props.tone === "muted" && "text-muted-foreground",
      )}
      data-slot="agent-status-text"
    >
      {props.dot === false ? null : (
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", dotClass)} />
      )}
      {props.children}
    </span>
  );
}

export function agentCardStatusModel(input: {
  connectionKind: RatelConnectionKind;
  linked: boolean;
  missingToolCount: number;
  posture: AgentPosture;
  unmanagedSkillCount: number;
}): {
  connectionLabel: string;
  healthLabel: string;
  tone: "muted" | "success" | "warning";
} {
  const connectionLabel =
    input.posture === "unavailable"
      ? "Unavailable"
      : input.connectionKind === "duplicate"
        ? "Duplicate connection"
        : input.connectionKind === "plugin"
          ? "Plugin connected"
          : input.linked
            ? "Connected"
            : "Not connected";
  const attentionParts = [
    input.missingToolCount > 0
      ? `${input.missingToolCount} tool${input.missingToolCount === 1 ? "" : "s"}`
      : null,
    input.unmanagedSkillCount > 0
      ? `${input.unmanagedSkillCount} skill${input.unmanagedSkillCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => Boolean(part));

  if (attentionParts.length > 0) {
    const needs =
      input.missingToolCount + input.unmanagedSkillCount === 1 ? "needs setup" : "need setup";
    return {
      connectionLabel,
      healthLabel: `${attentionParts.join(" · ")} ${needs}`,
      tone: "warning",
    };
  }
  if (input.posture === "unavailable" || !input.linked) {
    return { connectionLabel, healthLabel: "Setup needed", tone: "muted" };
  }
  return { connectionLabel, healthLabel: "Ready", tone: "success" };
}

function AgentOperationPanel(props: {
  availableSkills: SkillSummary[];
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  traceStatus?: AgentTracesResponse;
  onTraceStatusChanged: () => Promise<void>;
}) {
  const canImport =
    missingRatelEntryNames(props.host).length > 0 || props.availableSkills.length > 0;
  const canLink = props.host.posture !== "unavailable" && !props.host.connection.linked;
  const canRepairConnection =
    props.host.connection.kind === "duplicate" || props.host.connection.kind === "explicit";
  return (
    <section className="grid gap-7">
      <AgentTraceExporterSection
        hostKind={props.hostKind}
        onStatusChanged={props.onTraceStatusChanged}
        request={props.request}
        status={props.traceStatus}
      />
      {props.hostKind === "claude-code" && props.host.statusline ? (
        <ClaudeStatuslineSection
          onScanHosts={props.onScanHosts}
          request={props.request}
          state={props.host.statusline}
        />
      ) : null}
      {canRepairConnection ? (
        <AgentConnectionRepairSection
          host={props.host}
          onScanHosts={props.onScanHosts}
          request={props.request}
        />
      ) : null}
      {canImport ? (
        <SetupActionSection
          description="Choose unmanaged MCP entries and native skills, resolve MCP conflicts, then apply them together."
          title="Import MCPs and skills"
        >
          <PreviewFlow
            availableSkills={props.availableSkills}
            flow="import"
            host={props.host}
            hostKind={props.hostKind}
            key={`import:${props.hostKind}`}
            onScanHosts={props.onScanHosts}
            onSkillsImported={props.onSkillsImported}
            request={props.request}
          />
        </SetupActionSection>
      ) : null}
      {canLink ? (
        <SetupActionSection
          description="Install the Ratel plugin with its bundled skills, with a reviewed explicit MCP fallback if installation fails."
          title="Link Ratel integration"
        >
          <PreviewFlow
            availableSkills={[]}
            flow="link"
            host={props.host}
            hostKind={props.hostKind}
            key={`link:${props.hostKind}`}
            onScanHosts={props.onScanHosts}
            onSkillsImported={props.onSkillsImported}
            request={props.request}
          />
        </SetupActionSection>
      ) : null}
    </section>
  );
}

const TRACE_STATE_COPY: Record<
  AgentTraceState,
  { label: string; variant: "secondary" | "outline" | "warning" | "destructive" }
> = {
  disabled: { label: "Disabled", variant: "outline" },
  configured: { label: "Configured", variant: "secondary" },
  stale: { label: "Needs repair", variant: "warning" },
  conflict: { label: "Conflict", variant: "warning" },
  invalid: { label: "Invalid config", variant: "destructive" },
};

export function agentTraceCardModel(state: AgentTraceState): {
  action: "enable" | "repair" | "disable" | "confirm-overwrite" | null;
  irreversibleConfirmation: boolean;
} {
  if (state === "disabled") return { action: "enable", irreversibleConfirmation: false };
  if (state === "stale") return { action: "repair", irreversibleConfirmation: false };
  if (state === "configured") return { action: "disable", irreversibleConfirmation: false };
  if (state === "conflict") {
    return { action: "confirm-overwrite", irreversibleConfirmation: true };
  }
  return { action: null, irreversibleConfirmation: false };
}

export function agentTraceInstallCopy(state: AgentTraceState): {
  actionLabel: string | null;
  description: string;
  title: string;
} {
  const actionLabel =
    state === "disabled"
      ? "Enable"
      : state === "configured"
        ? "Disable"
        : state === "stale"
          ? "Repair"
          : state === "conflict"
            ? "Review"
            : null;
  return {
    actionLabel,
    description: "Send native telemetry to Ratel's local relay.",
    title: "Native telemetry",
  };
}

export interface AgentTraceLevelChoice {
  value: AgentTraceLevel;
  label: string;
  description: string;
  contentBearing: boolean;
}

export function agentTraceLevelChoices(hostKind: AgentHostKind): AgentTraceLevelChoice[] {
  const choices: AgentTraceLevelChoice[] = [
    {
      value: "off",
      label: "Off",
      description: "Do not route this agent's native traces or logs through Ratel.",
      contentBearing: false,
    },
    {
      value: "redacted",
      label: "Redacted",
      description:
        hostKind === "claude-code"
          ? "Route trace metadata and structured logs with prompts, responses, tool details, and tool content disabled."
          : "Route Codex trace spans only; structured logs and prompt content stay off.",
      contentBearing: false,
    },
  ];
  if (hostKind === "claude-code") {
    choices.push(
      {
        value: "tool-details",
        label: "Tool details",
        description:
          "Include tool execution details while prompts, assistant responses, and tool content stay disabled.",
        contentBearing: true,
      },
      {
        value: "full-content",
        label: "Full content",
        description: "Include prompts, assistant responses, tool details, and tool content.",
        contentBearing: true,
      },
    );
  } else {
    choices.push(
      {
        value: "tool-activity",
        label: "Tool activity",
        description:
          "Add structured Codex tool logs while user prompt logging stays off. Tool results include an output snippet.",
        contentBearing: true,
      },
      {
        value: "prompt-content",
        label: "Prompt content",
        description:
          "Also include Codex user prompts. Tool-result output snippets remain included; assistant response bodies are not promised.",
        contentBearing: true,
      },
    );
  }
  return choices;
}

export function agentTraceSelectionModel(
  state: AgentTraceState,
  currentLevel: AgentTraceObservedLevel,
  selectedLevel: AgentTraceLevel,
  signals?: AgentTraceHostStatus["signals"],
  hostKind?: AgentHostKind,
): {
  actionLabel: string;
  changed: boolean;
  requiresOverwriteConfirmation: boolean;
  requiresPrivacyConfirmation: boolean;
} {
  const ownsRatelSignal =
    signals?.traces === "configured" ||
    signals?.traces === "stale" ||
    signals?.logs === "configured" ||
    signals?.logs === "stale";
  const anySignalConflict = signals?.traces === "conflict" || signals?.logs === "conflict";
  const targetConflict = signals
    ? selectedLevel === "off"
      ? Boolean(anySignalConflict && !ownsRatelSignal)
      : hostKind === "codex" && selectedLevel === "redacted"
        ? signals.traces === "conflict"
        : Boolean(anySignalConflict)
    : state === "conflict";
  const conflictOff = targetConflict && selectedLevel === "off";
  const changed =
    !conflictOff && (state === "stale" || targetConflict || currentLevel !== selectedLevel);
  return {
    actionLabel: conflictOff
      ? "Keep existing"
      : selectedLevel === "off"
        ? "Turn off"
        : targetConflict
          ? "Review change"
          : state === "stale" && currentLevel === selectedLevel
            ? "Repair"
            : "Apply",
    changed,
    requiresOverwriteConfirmation: targetConflict && selectedLevel !== "off",
    requiresPrivacyConfirmation:
      selectedLevel === "tool-details" ||
      selectedLevel === "full-content" ||
      selectedLevel === "tool-activity" ||
      selectedLevel === "prompt-content",
  };
}

function defaultTraceLevel(host: AgentTraceHostStatus | undefined): AgentTraceLevel {
  if (!host) return "off";
  if (host.supportedLevels?.includes(host.level as AgentTraceLevel)) {
    return host.level as AgentTraceLevel;
  }
  return host.state === "disabled" ? "off" : "redacted";
}

function traceLevelPrivacyWarning(level: AgentTraceLevel): string | null {
  if (level === "tool-details") {
    return "Tool details may expose sensitive command, file, and integration metadata.";
  }
  if (level === "full-content") {
    return "Full content may expose source code, credentials, personal data, prompts, responses, and tool input or output.";
  }
  if (level === "tool-activity") {
    return "Codex tool activity includes codex.tool_result output snippets, which may expose sensitive content. User prompt logging remains off.";
  }
  if (level === "prompt-content") {
    return "Codex prompt content includes user prompts plus tool-result output snippets. Codex does not document assistant-response body capture.";
  }
  return null;
}

function AgentTraceExporterSection(props: {
  hostKind: AgentHostKind;
  onStatusChanged: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  status?: AgentTracesResponse;
}) {
  const host = props.status?.hosts.find(({ hostKind }) => hostKind === props.hostKind);
  const observedDefaultLevel = defaultTraceLevel(host);
  const observedHostKind = host?.hostKind;
  const [selectedLevel, setSelectedLevel] = useState<AgentTraceLevel>(() => observedDefaultLevel);
  const [pendingConfirmation, setPendingConfirmation] = useState<AgentTraceLevel | null>(null);
  const [restartNotice, setRestartNotice] = useState(false);
  const { isPending, runAction } = useAgentAction();
  useEffect(() => {
    if (!observedHostKind) return;
    setSelectedLevel(observedDefaultLevel);
    setPendingConfirmation(null);
  }, [observedDefaultLevel, observedHostKind]);

  if (!host || !props.status) {
    return (
      <SetupActionSection
        description="Reading the user-level native trace exporter configuration."
        title="Native trace export"
      >
        <Badge variant="outline">Checking</Badge>
      </SetupActionSection>
    );
  }

  const stateCopy = TRACE_STATE_COPY[host.state];
  const choices = agentTraceLevelChoices(props.hostKind).filter(({ value }) =>
    (
      host.supportedLevels ?? agentTraceLevelChoices(props.hostKind).map((item) => item.value)
    ).includes(value),
  );
  const selectedChoice = choices.find(({ value }) => value === selectedLevel) ?? choices[0];
  const selection = agentTraceSelectionModel(
    host.state,
    host.level,
    selectedLevel,
    host.signals,
    host.hostKind,
  );
  const privacyWarning = traceLevelPrivacyWarning(selectedLevel);
  const apply = async (level: AgentTraceLevel, overwrite = false) => {
    const action = level === "off" ? "disable" : "enable";
    const label = action === "enable" ? "Native trace detail updated" : "Native traces turned off";
    const ok = await runAction(label, async () => {
      const prepared = await props.request<PreparedAgentTraceResponse>(
        "/api/agent-traces/prepare",
        {
          method: "POST",
          body: { action, level, hostKinds: [props.hostKind], overwrite },
        },
      );
      return props.request(`/api/changes/${encodeURIComponent(prepared.changeId)}/commit`, {
        method: "POST",
      });
    });
    if (ok) {
      setPendingConfirmation(null);
      setRestartNotice(true);
      await props.onStatusChanged();
    }
  };
  const requestApply = () => {
    if (selection.requiresOverwriteConfirmation || selection.requiresPrivacyConfirmation) {
      setPendingConfirmation(selectedLevel);
      return;
    }
    void apply(selectedLevel);
  };

  return (
    <SetupActionSection description="Native diagnostics for this agent." title="Telemetry export">
      <div className="grid gap-3">
        <InstallActionRow
          action={
            host.state === "invalid" ? null : (
              <Button
                disabled={isPending || !selection.changed || pendingConfirmation !== null}
                onClick={requestApply}
                variant={selectedLevel === "off" ? "outline" : "default"}
              >
                {selection.actionLabel}
                {isPending ? <Button.LoadingIndicator label="Updating trace detail" /> : null}
              </Button>
            )
          }
          description={selectedChoice.description}
          meta={<Badge variant={stateCopy.variant}>{stateCopy.label}</Badge>}
          title="Native telemetry"
        />

        {host.state !== "invalid" ? (
          <div className="grid max-w-xl gap-1.5">
            <Label htmlFor={`native-trace-level-${props.hostKind}`}>Telemetry detail</Label>
            <Select
              disabled={isPending || pendingConfirmation !== null}
              onValueChange={(value) => setSelectedLevel(value as AgentTraceLevel)}
              value={selectedLevel}
            >
              <SelectTrigger className="w-full" id={`native-trace-level-${props.hostKind}`}>
                <SelectValue>{selectedChoice.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{selectedChoice.description}</p>
          </div>
        ) : null}

        {privacyWarning ? (
          <Alert variant="destructive">
            <AlertTitle>Sensitive telemetry content</AlertTitle>
            <AlertDescription>{privacyWarning}</AlertDescription>
          </Alert>
        ) : null}

        {!props.status.cloudConfigured ? (
          <RatelCloudTraceSetup onConfigured={props.onStatusChanged} request={props.request} />
        ) : null}

        {host.restartRequired || restartNotice ? (
          <p className="text-sm text-muted-foreground">
            Start a new {host.displayName} session for persisted exporter changes to take effect.
          </p>
        ) : null}
        {host.conflictingFields.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Conflicting fields: {host.conflictingFields.join(", ")}
          </p>
        ) : null}
        {host.warnings.map((warning) => (
          <p className="text-sm text-muted-foreground" key={warning}>
            Warning: {warning}
          </p>
        ))}

        {pendingConfirmation ? (
          <Alert variant="destructive">
            <AlertTitle>
              {selection.requiresOverwriteConfirmation
                ? "Replace exporter and apply this detail level?"
                : "Confirm sensitive telemetry content"}
            </AlertTitle>
            <AlertDescription>
              {selection.requiresPrivacyConfirmation
                ? traceLevelPrivacyWarning(pendingConfirmation)
                : null}
              {selection.requiresOverwriteConfirmation
                ? " Ratel does not retain a backup and cannot restore the previous exporter."
                : null}
            </AlertDescription>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={isPending}
                onClick={() => setPendingConfirmation(null)}
                variant="outline"
              >
                Cancel
              </Button>
              <Button
                disabled={isPending}
                onClick={() =>
                  void apply(pendingConfirmation, selection.requiresOverwriteConfirmation)
                }
                variant="destructive"
              >
                Confirm and apply
                {isPending ? <Button.LoadingIndicator label="Applying trace detail" /> : null}
              </Button>
            </div>
          </Alert>
        ) : null}
      </div>
    </SetupActionSection>
  );
}

function RatelCloudTraceSetup(props: {
  onConfigured: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const [editing, setEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const { isPending, runAction } = useAgentAction();

  const save = async () => {
    const ok = await runAction("Ratel Cloud tracing configured", async () => {
      const cloud = await props.request<CloudTraceSettingsStatus>("/api/cloud-traces");
      return props.request<CloudTraceSettingsStatus>("/api/cloud-traces", {
        method: "PATCH",
        body: cloudTraceSetupPatch(cloud.endpoint, apiKey),
      });
    });
    if (ok) {
      setApiKey("");
      setEditing(false);
      await props.onConfigured();
    }
  };

  return (
    <div className="rounded-xl border border-border bg-background px-4 py-3">
      {editing ? (
        <form
          className="grid max-w-xl gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="ratel-cloud-trace-api-key">Ratel Cloud API key</Label>
            <Input
              autoComplete="new-password"
              autoFocus
              disabled={isPending}
              id="ratel-cloud-trace-api-key"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste API key"
              type="password"
              value={apiKey}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            The key is stored by the local daemon and is never returned to the browser.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={isPending}
              onClick={() => {
                setApiKey("");
                setEditing(false);
              }}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button disabled={isPending || !apiKey.trim()} type="submit">
              Save API key
              {isPending ? <Button.LoadingIndicator label="Saving Ratel Cloud API key" /> : null}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-sm">Cloud key required</p>
            <p className="text-xs text-muted-foreground">
              Add a key before exporting to Ratel Cloud.
            </p>
          </div>
          <Button onClick={() => setEditing(true)} type="button" variant="outline">
            Add API key
          </Button>
        </div>
      )}
    </div>
  );
}

function AgentConnectionRepairSection(props: {
  host: DetectedAgentHostSummary;
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const { isPending, runAction } = useAgentAction();
  const duplicate = props.host.connection.kind === "duplicate";
  const actionLabel = duplicate ? "Fix duplicate installation" : "Switch to plugin";
  const commit = async () => {
    const ok = await runAction(actionLabel, () =>
      props.request("/api/agent-connection/repair", {
        method: "POST",
        body: { hostKind: props.host.kind },
      }),
    );
    if (ok) await props.onScanHosts();
  };

  return (
    <SetupActionSection
      description={
        duplicate
          ? `Ratel is connected to ${props.host.displayName} twice. Remove the extra MCP connection and keep the plugin.`
          : `Replace the standalone MCP connection with the Ratel plugin, including its bundled skills. If plugin installation fails, your current connection stays unchanged.`
      }
      title={duplicate ? "Duplicate installation detected" : "Upgrade to the Ratel plugin"}
    >
      <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="font-medium text-sm">
            {duplicate ? "Use one clean Ratel connection" : "Get the complete Ratel integration"}
          </p>
          <p className="mt-1 max-w-xl text-muted-foreground text-xs">
            {duplicate
              ? "Ratel will remove only its recognized standalone MCP entry. Other MCP servers and the plugin stay untouched."
              : "Ratel installs the plugin first and removes the old MCP entry only after installation succeeds."}
          </p>
        </div>
        <Button
          className="min-h-12 px-6 text-base md:min-w-44"
          disabled={isPending}
          onClick={() => void commit()}
        >
          {duplicate ? <Wrench /> : <Sparkles />}
          {isPending && <Button.LoadingIndicator label={actionLabel} />}
          {actionLabel}
        </Button>
      </div>
    </SetupActionSection>
  );
}

function ClaudeStatuslineSection(props: {
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  state: ClaudeStatuslineState;
}) {
  const { isPending, runAction } = useAgentAction();
  const installed = props.state.status === "installed";
  const otherConfigured = props.state.status === "other";
  const actionLabel = installed
    ? "Uninstall statusline"
    : otherConfigured
      ? "Replace statusline"
      : "Install statusline";
  const commit = async () => {
    const ok = await runAction(actionLabel, () =>
      installed
        ? props.request("/api/claude-statusline/uninstall", { method: "POST" })
        : props.request("/api/claude-statusline/install", {
            method: "POST",
            body: { force: otherConfigured },
          }),
    );
    if (ok) await props.onScanHosts();
  };

  return (
    <SetupActionSection description="Show Ratel status in Claude Code." title="Statusline">
      <InstallActionRow
        action={
          <Button
            disabled={isPending}
            onClick={() => void commit()}
            variant={installed ? "outline" : "default"}
          >
            {installed ? <X /> : <FileText />}
            {isPending ? <Button.LoadingIndicator label={actionLabel} /> : null}
            {actionLabel}
          </Button>
        }
        description={
          installed
            ? "Installed and managed by Ratel."
            : otherConfigured
              ? "Replace the current custom statusline."
              : "See context use and Ratel activity at a glance."
        }
        meta={
          !props.state.ratelEnabled ? (
            <span className="text-amber-700 text-xs dark:text-amber-300">Connect Ratel first</span>
          ) : null
        }
        title="Claude Code statusline"
      />
    </SetupActionSection>
  );
}

function InstallActionRow(props: {
  action: React.ReactNode;
  description: string;
  meta?: React.ReactNode;
  title: string;
}) {
  return (
    <div className="grid gap-4 rounded-xl border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="font-medium text-sm">{props.title}</p>
          {props.meta}
        </div>
        <p className="mt-1 text-muted-foreground text-xs">{props.description}</p>
      </div>
      {props.action ? <div className="flex md:justify-end">{props.action}</div> : null}
    </div>
  );
}

function SetupActionSection(props: {
  children: React.ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h3 className="text-lg font-semibold tracking-tight">{props.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
      </div>
      {props.children}
    </section>
  );
}

function PreviewFlow(props: {
  availableSkills: SkillSummary[];
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const { context } = useRatelApp();
  const { runAction } = useAgentAction();
  const [preview, setPreview] = useState<AgentPlanPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const endpoint =
    props.flow === "import" ? "/api/agents/import/prepare" : "/api/agents/link/prepare";
  const previewPath = `${endpoint}?r=${refreshNonce}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const body = await props.request<PreparedAgentChangeResponse>(previewPath, {
          method: "POST",
          body: {
            hostKind: props.hostKind,
          },
        });
        if (cancelled) {
          await props.request(`/api/changes/${encodeURIComponent(body.changeId)}`, {
            method: "DELETE",
          });
          return;
        }
        setPreview((current) => {
          if (current) {
            void props.request(`/api/changes/${encodeURIComponent(current.changeId)}`, {
              method: "DELETE",
            });
          }
          return agentPreviewFromPrepared(body);
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not build the setup preview");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [previewPath, props.hostKind, props.request]);

  const agentChanges = preview?.plan.agentChanges ?? [];
  const linkedAndCovered =
    props.host.connection.linked && missingRatelEntryNames(props.host).length === 0;
  const friendlyNoOp = Boolean(
    preview?.emptyReason && linkedAndCovered && props.availableSkills.length === 0,
  );
  const initialImportWorkflow = useMemo(
    () =>
      beginAgentImportWorkflow({
        hostKind: props.hostKind,
        linked: props.host.connection.linked,
        statuslineInstalled: props.host.statusline?.status === "installed",
      }),
    [props.host.connection.linked, props.host.statusline?.status, props.hostKind],
  );

  const setPreparedDialogOpen = (open: boolean) => {
    setDialogOpen(open);
    if (!open && preview) {
      void props.request(`/api/changes/${encodeURIComponent(preview.changeId)}`, {
        method: "DELETE",
      });
      setPreview(null);
      setRefreshNonce((value) => value + 1);
    }
  };

  const applyImport = async (
    importPreview: AgentPlanPreview,
    _conflictStrategy: ConflictStrategy,
    _replaceConflicts: string[],
  ) => {
    const applied = await runAction("Ratel and agent config changes applied", () =>
      props.request(`/api/changes/${encodeURIComponent(importPreview.changeId)}/commit`, {
        method: "POST",
      }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const commitAgentChange = async (
    activePreview: AgentPlanPreview,
    _options?: { conflictStrategy?: ConflictStrategy; replaceConflicts?: string[] },
  ) => {
    const applied = await runAction(
      props.flow === "import" ? "Source agent cleanup applied" : "Link complete",
      () =>
        props.request(`/api/changes/${encodeURIComponent(activePreview.changeId)}/commit`, {
          method: "POST",
        }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const applyLinkFromImport = async () => {
    const prepared = await props.request<PreparedAgentChangeResponse>("/api/agents/link/prepare", {
      method: "POST",
      body: { hostKind: props.hostKind },
    });
    const linkPreview = agentPreviewFromPrepared(prepared);
    if (linkPreview.plan.agentChanges.length > 0) {
      const linked = await runAction("Link complete", () =>
        props.request(`/api/changes/${encodeURIComponent(linkPreview.changeId)}/commit`, {
          method: "POST",
        }),
      );
      if (!linked) return false;
    } else {
      await props.request(`/api/changes/${encodeURIComponent(linkPreview.changeId)}`, {
        method: "DELETE",
      });
    }
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const installStatuslineFromImport = async (force: boolean) => {
    const installed = await runAction(force ? "Replace statusline" : "Install statusline", () =>
      props.request("/api/claude-statusline/install", {
        method: "POST",
        body: { force },
      }),
    );
    if (!installed) return false;
    await props.onScanHosts();
    return true;
  };

  const commitImport = async (
    importPreview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => {
    if (importPreview.plan.ratelChanges.length > 0 || importPreview.plan.agentChanges.length > 0) {
      const configsApplied = await applyImport(importPreview, conflictStrategy, replaceConflicts);
      if (!configsApplied) return false;
    } else {
      await props.request(`/api/changes/${encodeURIComponent(importPreview.changeId)}`, {
        method: "DELETE",
      });
    }
    if (selectedSkills.length > 0) {
      const skillsApplied = await importSelectedSkills(selectedSkills);
      if (!skillsApplied) return false;
    }
    return true;
  };

  const importSelectedSkills = async (selectedSkills: SkillSummary[]) => {
    const applied = await runAction(
      `Now managing ${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"}`,
      async () => {
        const target = defaultSkillImportTarget(context);
        if (!target) throw new Error("Select Global or a project before importing skills");
        const selections = buildSkillImportSelections(selectedSkills, context, target);
        await applySkillImportSelections(props.request, selections);
      },
    );
    if (!applied) return false;
    await props.onSkillsImported();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const commitLink = async () => {
    if (!preview) return false;
    if (agentChanges.length > 0) {
      const linked = await commitAgentChange(preview);
      if (!linked) return false;
    }
    setDialogOpen(false);
    return true;
  };

  return (
    <div className="grid gap-4">
      {loading && !preview ? (
        <div className="rounded-md border border-border px-3 py-6 text-sm text-muted-foreground">
          Building preview...
        </div>
      ) : null}

      {error && !preview ? (
        <Alert variant="destructive">
          <AlertTitle>Could not build {props.flow} preview</AlertTitle>
          <AlertDescription className="grid justify-items-start gap-3">
            <span>{error}</span>
            <Button
              onClick={() => setRefreshNonce((value) => value + 1)}
              size="sm"
              variant="outline"
            >
              <RefreshCw />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {preview ? (
        <>
          {friendlyNoOp ? (
            <LinkedCoveredPreview flow={props.flow} host={props.host} />
          ) : (
            <SetupRecap
              availableSkills={props.availableSkills}
              flow={props.flow}
              onOpen={() => setPreparedDialogOpen(true)}
              preview={preview}
            />
          )}
          {preview.emptyReason && !friendlyNoOp && props.availableSkills.length === 0 ? (
            <Alert>
              <AlertTitle>No changes available</AlertTitle>
              <AlertDescription>{preview.emptyReason}</AlertDescription>
            </Alert>
          ) : null}
          {!friendlyNoOp && props.flow === "import" ? (
            <ImportSceneDialog
              onCommit={commitImport}
              onInstallStatusline={installStatuslineFromImport}
              onLink={applyLinkFromImport}
              onOpenChange={setPreparedDialogOpen}
              open={dialogOpen}
              preview={preview}
              request={props.request}
              hostKind={props.hostKind}
              statuslineStatus={props.host.statusline?.status}
              workflow={initialImportWorkflow}
              skills={props.availableSkills}
            />
          ) : null}
          {!friendlyNoOp && props.flow === "link" ? (
            <LinkSceneDialog
              onCommit={commitLink}
              onOpenChange={setPreparedDialogOpen}
              open={dialogOpen}
              preview={preview}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SetupRecap(props: {
  availableSkills: SkillSummary[];
  flow: SetupFlow;
  onOpen: () => void;
  preview: AgentPlanPreview;
}) {
  const changes = props.preview.plan.ratelChanges.length + props.preview.plan.agentChanges.length;
  const mcpCount = props.preview.candidates.length;
  const skillCount = props.flow === "import" ? props.availableSkills.length : 0;
  const importableCount = mcpCount + skillCount;
  const actionLabel = props.flow === "import" ? "Import" : "Link";
  return (
    <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div>
        <p className="font-medium text-sm">
          {props.flow === "import"
            ? importAvailabilityLabel(mcpCount, skillCount)
            : "Ratel will install the agent plugin, including its bundled skills."}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          {props.flow === "import"
            ? "Skills are selected first; MCP conflict handling follows only when needed."
            : "If plugin installation fails, the reviewed MCP fallback is applied and reported. Native MCP entries are preserved."}
        </p>
      </div>
      <Button
        className="min-h-12 px-6 text-base md:min-w-40"
        disabled={props.flow === "import" ? importableCount === 0 : changes === 0}
        onClick={props.onOpen}
      >
        {props.flow === "import" ? <Download /> : <LinkIcon />}
        {actionLabel}
      </Button>
    </div>
  );
}

function importAvailabilityLabel(mcpCount: number, skillCount: number) {
  const parts: string[] = [];
  if (mcpCount > 0) parts.push(`${mcpCount} MCP entr${mcpCount === 1 ? "y" : "ies"}`);
  if (skillCount > 0) parts.push(`${skillCount} skill${skillCount === 1 ? "" : "s"}`);
  if (parts.length === 0) return "Nothing available to import.";
  return `${parts.join(" and ")} available.`;
}

type ImportScene =
  | "link"
  | "skills"
  | "entries"
  | "strategy"
  | "pick-conflicts"
  | "review"
  | "statusline";

function ImportSceneDialog(props: {
  hostKind: AgentHostKind;
  onCommit: (
    preview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => Promise<boolean>;
  onInstallStatusline: (force: boolean) => Promise<boolean>;
  onLink: () => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  preview: AgentPlanPreview;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  skills: SkillSummary[];
  statuslineStatus: ClaudeStatuslineState["status"] | undefined;
  workflow: AgentImportWorkflowState;
}) {
  const [scene, setScene] = useState<ImportScene>(
    props.workflow.step === "link" ? "link" : "skills",
  );
  const [workflow, setWorkflow] = useState(props.workflow);
  const [pendingAction, setPendingAction] = useState<"commit" | "link" | "statusline" | null>(null);
  const [draftPreview, setDraftPreview] = useState<AgentPlanPreview>(props.preview);
  const [draftSelection, setDraftSelection] = useState<string[]>(props.preview.selected);
  const [draftSkillSelection, setDraftSkillSelection] = useState<Set<string>>(new Set());
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>("add-missing-only");
  const [replaceConflicts, setReplaceConflicts] = useState<string[]>([]);
  const statuslineAction = importStatuslineAction(props.statuslineStatus);
  const wasOpenRef = useRef(false);
  const previewRequestIdRef = useRef(0);
  const activeChangeIdRef = useRef(draftPreview.changeId);
  const selected = new Set(draftSelection);
  const selectedSkills = uniqueSkillImports(
    props.skills.filter((skill) => draftSkillSelection.has(skillKey(skill))),
  );
  const conflicts = draftPreview.plan.summary.conflicts;
  const requiresConflictSelection =
    draftSelection.length > 0 && conflicts.length > 0 && conflictStrategy === "replace-selected";
  const hasSelectedImport = draftSelection.length > 0 || selectedSkills.length > 0;
  const hasSelectableEntries = props.preview.candidates.length > 0;
  const goAfterSkills = () => {
    if (hasSelectableEntries) {
      setScene("entries");
    } else if (selectedSkills.length > 0) {
      setScene("review");
    } else {
      props.onOpenChange(false);
    }
  };
  const goAfterEntries = () =>
    setScene(draftSelection.length > 0 && conflicts.length > 0 ? "strategy" : "review");
  const goAfterStrategy = () =>
    setScene(conflictStrategy === "replace-selected" ? "pick-conflicts" : "review");
  const previousReviewScene = () => {
    if (requiresConflictSelection) return "pick-conflicts";
    if (draftSelection.length > 0 && conflicts.length > 0) return "strategy";
    if (hasSelectableEntries) return "entries";
    return "skills";
  };

  useEffect(() => {
    const opening = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!opening) return;
    setScene(props.workflow.step === "link" ? "link" : "skills");
    setWorkflow(props.workflow);
    setDraftPreview(props.preview);
    setDraftSelection(props.preview.selected);
    setDraftSkillSelection(new Set());
    setConflictStrategy("add-missing-only");
    setReplaceConflicts([]);
  }, [props.open, props.preview, props.workflow]);

  useEffect(() => {
    activeChangeIdRef.current = draftPreview.changeId;
  }, [draftPreview.changeId]);

  useEffect(() => {
    if (props.open) return;
    void props.request(`/api/changes/${encodeURIComponent(activeChangeIdRef.current)}`, {
      method: "DELETE",
    });
  }, [props.open, props.request]);

  useEffect(
    () => () => {
      void props.request(`/api/changes/${encodeURIComponent(activeChangeIdRef.current)}`, {
        method: "DELETE",
      });
    },
    [props.request],
  );

  const loadDraftPreview = useCallback(async () => {
    const requestId = ++previewRequestIdRef.current;
    const body = await props.request<PreparedAgentChangeResponse>("/api/agents/import/prepare", {
      method: "POST",
      body: {
        hostKind: props.hostKind,
        selection: draftSelection,
        conflictStrategy,
        replaceConflicts,
      },
    });
    if (requestId !== previewRequestIdRef.current) {
      await props.request(`/api/changes/${encodeURIComponent(body.changeId)}`, {
        method: "DELETE",
      });
      return null;
    }
    return agentPreviewFromPrepared(body);
  }, [conflictStrategy, draftSelection, props.hostKind, props.request, replaceConflicts]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    const refreshDraftPreview = async () => {
      const body = await loadDraftPreview();
      if (!cancelled && body) {
        setDraftPreview((current) => {
          if (current.changeId !== body.changeId) {
            void props.request(`/api/changes/${encodeURIComponent(current.changeId)}`, {
              method: "DELETE",
            });
          }
          return body;
        });
      } else if (body) {
        await props.request(`/api/changes/${encodeURIComponent(body.changeId)}`, {
          method: "DELETE",
        });
      }
    };
    void refreshDraftPreview();
    return () => {
      cancelled = true;
    };
  }, [loadDraftPreview, props.open, props.request]);

  const commit = async () => {
    setPendingAction("commit");
    try {
      const committed = await props.onCommit(
        draftPreview,
        conflictStrategy,
        replaceConflicts,
        selectedSkills,
      );
      if (!committed || workflow.step !== "import") return;
      const next = advanceAgentImportWorkflow(workflow, { type: "import-completed" });
      setWorkflow(next);
      if (next.step === "statusline") setScene("statusline");
      else props.onOpenChange(false);
    } finally {
      setPendingAction(null);
    }
  };

  const linkAndContinue = async () => {
    setPendingAction("link");
    try {
      const refreshedPreview = await linkThenRefreshImportPreview(props.onLink, async () => {
        const preview = await loadDraftPreview();
        if (!preview) throw new Error("import preview refresh was superseded");
        return preview;
      });
      if (!refreshedPreview || workflow.step !== "link") return;
      setDraftPreview(refreshedPreview);
      setWorkflow(advanceAgentImportWorkflow(workflow, { type: "link-completed" }));
      setScene("skills");
    } finally {
      setPendingAction(null);
    }
  };

  const skipLink = () => {
    if (workflow.step !== "link") return;
    setWorkflow(advanceAgentImportWorkflow(workflow, { type: "link-skipped" }));
    setScene("skills");
  };

  const installStatusline = async () => {
    setPendingAction("statusline");
    try {
      if (
        !(await props.onInstallStatusline(statuslineAction.force)) ||
        workflow.step !== "statusline"
      )
        return;
      setWorkflow(advanceAgentImportWorkflow(workflow, { type: "statusline-installed" }));
      props.onOpenChange(false);
    } finally {
      setPendingAction(null);
    }
  };

  const skipStatusline = () => {
    if (workflow.step !== "statusline") return;
    setWorkflow(advanceAgentImportWorkflow(workflow, { type: "statusline-skipped" }));
    props.onOpenChange(false);
  };

  const toggleSkill = (skill: SkillSummary) => {
    setDraftSkillSelection((current) => {
      const next = new Set(current);
      const key = skillKey(skill);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSkills = (skills: SkillSummary[], shouldSelect: boolean) => {
    setDraftSkillSelection((current) => {
      const next = new Set(current);
      for (const skill of skills) {
        const key = skillKey(skill);
        if (shouldSelect) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <SceneDialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (open) setScene(props.workflow.step === "link" ? "link" : "skills");
      }}
      scene={scene}
      title="Import"
    >
      {scene === "link" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel import
              </Button>
              <Button
                disabled={pendingAction !== null}
                onClick={skipLink}
                type="button"
                variant="outline"
              >
                Continue without linking
              </Button>
              <Button
                disabled={pendingAction !== null}
                onClick={() => void linkAndContinue()}
                type="button"
              >
                <LinkIcon />
                {pendingAction === "link" && <Button.LoadingIndicator label="Linking Ratel" />}
                Link Ratel and continue
              </Button>
            </>
          }
          kicker="Link"
          title="Link Ratel first?"
        >
          <Alert>
            <AlertTitle>{props.preview.host.displayName} is not linked</AlertTitle>
            <AlertDescription>
              {unlinkedAgentImportWarning(props.preview.host.displayName)}
            </AlertDescription>
          </Alert>
        </ScenePanel>
      ) : null}
      {scene === "skills" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button onClick={goAfterSkills} type="button">
                {hasSelectableEntries || selectedSkills.length > 0 ? "Continue" : "Done"}
              </Button>
            </>
          }
          kicker="Skills"
          title="Choose skills"
        >
          <div className="grid gap-3">
            {props.skills.length > 0 ? (
              <div className="grid">
                <SkillImportPicker
                  className="[&_[data-skill-scroll]]:max-h-72"
                  flushScroll
                  onToggle={toggleSkill}
                  onToggleAll={toggleSkills}
                  resetKey={`${props.open}:${props.skills.length}`}
                  selected={draftSkillSelection}
                  skills={props.skills}
                  title="Skills"
                />
              </div>
            ) : (
              <p className="rounded-md border border-border px-3 py-6 text-center text-muted-foreground text-sm">
                No external skills to manage for this agent.
              </p>
            )}
          </div>
        </ScenePanel>
      ) : null}
      {scene === "entries" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button onClick={() => setScene("skills")} type="button" variant="outline">
                Back
              </Button>
              <Button disabled={!hasSelectedImport} onClick={goAfterEntries} type="button">
                Continue
              </Button>
            </>
          }
          kicker="Tools"
          title="Choose tool entries"
        >
          <div className="grid gap-3">
            {props.preview.candidates.length > 0 ? (
              <SceneScrollSection className="max-h-72">
                {props.preview.candidates.map((candidate) => {
                  const isSelected = selected.has(candidate.name);
                  return (
                    <button
                      className={cn(
                        "grid w-full gap-1 border-border border-b px-3 py-2 text-left transition-colors last:border-b-0",
                        isSelected ? "bg-brand-green/10" : "bg-background hover:bg-muted/35",
                      )}
                      key={`${candidate.scope}:${candidate.name}`}
                      onClick={() =>
                        setDraftSelection((current) => toggleSelection(current, candidate.name))
                      }
                      type="button"
                    >
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <Checkbox
                            checked={isSelected}
                            className="pointer-events-none"
                            tabIndex={-1}
                          />
                          <span className="truncate font-medium">{candidate.name}</span>
                        </span>
                        <Badge variant="outline">{candidate.scope}</Badge>
                      </div>
                      <span className="truncate pl-6 text-xs text-muted-foreground">
                        {summarizeEntry(candidate.entry)}
                      </span>
                    </button>
                  );
                })}
              </SceneScrollSection>
            ) : null}
          </div>
        </ScenePanel>
      ) : null}
      {scene === "strategy" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={() => setScene("entries")} type="button" variant="outline">
                Back
              </Button>
              <Button onClick={goAfterStrategy} type="button">
                Continue
              </Button>
            </>
          }
          kicker="Conflicts"
          title="Resolve matching names"
        >
          <div className="grid gap-2">
            <ConflictStrategyButton
              active={conflictStrategy === "add-missing-only"}
              detail="Leave existing Ratel entries unchanged and import only new names."
              label="Import new only"
              onClick={() => setConflictStrategy("add-missing-only")}
            />
            <ConflictStrategyButton
              active={conflictStrategy === "replace-from-agent"}
              detail="Use the agent version for every matching name."
              label="Use all agent versions"
              onClick={() => setConflictStrategy("replace-from-agent")}
            />
            <ConflictStrategyButton
              active={conflictStrategy === "replace-selected"}
              detail="Pick which matching names should use the agent version."
              label="Choose per entry"
              onClick={() => setConflictStrategy("replace-selected")}
            />
          </div>
        </ScenePanel>
      ) : null}
      {scene === "pick-conflicts" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button onClick={() => setScene("strategy")} type="button" variant="outline">
                Back
              </Button>
              <Button onClick={() => setScene("review")} type="button">
                Review diff
              </Button>
            </>
          }
          kicker="Conflicts"
          title="Pick agent versions"
        >
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              Selected entries will overwrite the matching Ratel entry. Unselected entries keep the
              current Ratel version.
            </p>
            <SceneScrollSection className="grid max-h-80 gap-2">
              <ConflictPickList
                conflicts={conflicts}
                onToggleReplace={(key) =>
                  setReplaceConflicts((current) => toggleSelection(current, key))
                }
                replaceConflicts={new Set(replaceConflicts)}
              />
            </SceneScrollSection>
          </div>
        </ScenePanel>
      ) : null}
      {scene === "review" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button
                onClick={() => setScene(previousReviewScene())}
                type="button"
                variant="outline"
              >
                Back
              </Button>
              <Button
                disabled={pendingAction !== null || !hasSelectedImport}
                onClick={() => void commit()}
                type="button"
              >
                <FileText />
                {pendingAction === "commit" && (
                  <Button.LoadingIndicator label="Committing import" />
                )}
                Commit import
              </Button>
            </>
          }
          kicker="Review"
          title="Review import"
          wide
        >
          <SceneScrollSection className="grid max-h-[65vh] gap-4">
            <ChangeList changes={draftPreview.plan.ratelChanges} defaultOpen title="Ratel config" />
            <ChangeList
              changes={draftPreview.plan.agentChanges}
              defaultOpen
              title={`${props.preview.host.displayName} source cleanup`}
            />
            <SkillActivationReview skills={selectedSkills} />
          </SceneScrollSection>
        </ScenePanel>
      ) : null}
      {scene === "statusline" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={skipStatusline} type="button" variant="outline">
                Skip
              </Button>
              <Button
                disabled={pendingAction !== null}
                onClick={() => void installStatusline()}
                type="button"
              >
                <FileText />
                {pendingAction === "statusline" && (
                  <Button.LoadingIndicator label={statuslineAction.actionLabel} />
                )}
                {statuslineAction.actionLabel}
              </Button>
            </>
          }
          kicker="Statusline"
          title={statuslineAction.title}
        >
          <p className="text-sm text-muted-foreground">{statuslineAction.description}</p>
        </ScenePanel>
      ) : null}
    </SceneDialog>
  );
}

function LinkSceneDialog(props: {
  onCommit: () => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  preview: AgentPlanPreview;
}) {
  const [committing, setCommitting] = useState(false);
  const commit = async () => {
    setCommitting(true);
    try {
      await props.onCommit();
    } finally {
      setCommitting(false);
    }
  };

  return (
    <SceneDialog open={props.open} onOpenChange={props.onOpenChange} scene="review" title="Link">
      <ScenePanel
        flushFooter
        footer={
          <>
            <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={committing} onClick={() => void commit()} type="button">
              <LinkIcon />
              {committing && <Button.LoadingIndicator label="Committing link" />}
              Commit link
            </Button>
          </>
        }
        kicker="Review"
        title="Review link and fallback"
        wide
      >
        <SceneScrollSection className="grid max-h-[65vh] gap-4">
          <Alert>
            <AlertTitle>Plugin first</AlertTitle>
            <AlertDescription>
              Ratel will install the {props.preview.host.displayName} plugin first. If that fails,
              it will report the failure and apply only the explicit MCP changes reviewed below.
            </AlertDescription>
          </Alert>
          <ChangeList
            changes={props.preview.plan.agentChanges}
            defaultOpen
            title={`${props.preview.host.displayName} MCP fallback`}
          />
        </SceneScrollSection>
      </ScenePanel>
    </SceneDialog>
  );
}

function SkillActivationReview(props: { skills: SkillSummary[] }) {
  if (props.skills.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2">
      <h4 className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <Sparkles className="size-4" />
        Skills
      </h4>
      <div className="divide-y divide-border border border-border bg-background">
        {props.skills.map((skill) => (
          <div
            className="flex min-w-0 items-start justify-between gap-3 px-3 py-2"
            key={skillKey(skill)}
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-sm">{skill.name}</p>
              {skill.description ? (
                <p className="line-clamp-2 text-muted-foreground text-xs">{skill.description}</p>
              ) : null}
            </div>
            <Badge className="shrink-0" variant="outline">
              {skill.source}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

function SceneDialog(props: {
  children: React.ReactNode;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  scene: string;
  title: string;
}) {
  const [measureRef, bounds] = useMeasure();
  return (
    <AnimatePresence>
      {props.open ? (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-end bg-black/35 p-3 sm:place-items-center sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            aria-label="Close dialog"
            className="absolute inset-0 cursor-default"
            onClick={() => props.onOpenChange(false)}
            type="button"
          />
          <motion.div
            animate={{
              height: bounds.height || "auto",
              scale: 1,
              transition: { duration: 0.27, ease: [0.25, 1, 0.5, 1] },
              y: 0,
            }}
            className="relative w-full max-w-4xl min-w-0 overflow-hidden border border-border bg-background shadow-2xl"
            initial={{ y: 24, scale: 0.985 }}
            exit={{ y: 24, scale: 0.985 }}
          >
            <div className="min-w-0" ref={measureRef}>
              <div className="flex items-center justify-between border-border border-b px-4 py-3">
                <p className="font-medium">{props.title}</p>
                <Button
                  aria-label="Close"
                  onClick={() => props.onOpenChange(false)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <X />
                </Button>
              </div>
              <AnimatePresence initial={false} mode="popLayout" custom={props.scene}>
                <motion.div
                  key={props.scene}
                  initial={{ opacity: 0, scale: 0.985, filter: "blur(3px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 0.985, filter: "blur(3px)" }}
                  transition={{ duration: 0.2, ease: [0.26, 0.08, 0.25, 1] }}
                >
                  <div className="min-w-0">{props.children}</div>
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function ScenePanel(props: {
  children: React.ReactNode;
  flushFooter?: boolean;
  footer: React.ReactNode;
  kicker: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <div className="grid min-w-0">
      <div className="min-w-0 px-4 pt-4 pb-5 sm:px-5 sm:pt-5">
        <DetailLabel>{props.kicker}</DetailLabel>
        <h3 className="mt-1 text-xl font-semibold tracking-tight">{props.title}</h3>
      </div>
      <div className={cn("grid min-w-0 gap-5 px-4 sm:px-5", props.flushFooter ? "pb-0" : "pb-5")}>
        {props.children}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-border border-t px-4 py-4 sm:px-5">
        {props.footer}
      </div>
    </div>
  );
}

function SceneScrollSection(props: { children: React.ReactNode; className?: string }) {
  return (
    <div className="-mx-4 min-w-0 border-border border-t sm:-mx-5">
      <div className={cn("min-w-0 overflow-auto px-4 py-3 sm:px-5", props.className)}>
        {props.children}
      </div>
    </div>
  );
}

function ConflictStrategyButton(props: {
  active: boolean;
  detail: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "grid gap-1 border px-3 py-3 text-left transition-colors",
        props.active ? "border-brand-green bg-brand-green/10" : "border-border bg-background",
      )}
      onClick={props.onClick}
      type="button"
    >
      <span className="font-medium">{props.label}</span>
      <span className="text-sm text-muted-foreground">{props.detail}</span>
    </button>
  );
}

function ConflictPickList(props: {
  conflicts: ImportConflict[];
  onToggleReplace: (key: string) => void;
  replaceConflicts: Set<string>;
}) {
  return (
    <div className="grid gap-2">
      {props.conflicts.map((conflict) => {
        const key = `${conflict.scope}:${conflict.name}`;
        const selected = props.replaceConflicts.has(key);
        return (
          <button
            className="grid min-w-0 gap-2 border border-border bg-background px-3 py-2 text-left"
            key={key}
            onClick={() => props.onToggleReplace(key)}
            type="button"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{conflict.name}</span>
              <Badge variant="outline">{conflict.scope}</Badge>
            </div>
            <ConflictJsonDiff conflict={conflict} selected={selected} />
          </button>
        );
      })}
    </div>
  );
}

function ConflictJsonDiff(props: { conflict: ImportConflict; selected: boolean }) {
  const before = serializeEntryForDiff(props.conflict.existing);
  const after = serializeEntryForDiff(props.conflict.incoming);
  const patch = structuredPatch("Ratel config", "Agent config", before, after, "", "", {
    context: 2,
  });
  const rows = patch.hunks.flatMap(diffRowsFromHunk);
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No JSON differences.</p>;
  }
  return (
    <div className="grid min-w-0 gap-2">
      <ConflictResolutionPreview conflict={props.conflict} selected={props.selected} />
      <p className="text-xs text-muted-foreground">
        {props.selected ? "Import agent version" : "Keeping Ratel version"}
      </p>
      <div className="max-h-44 max-w-full overflow-auto border border-border bg-muted/20">
        <DiffRowsTable conflictSelection={props.selected ? "agent" : "ratel"} rows={rows} />
      </div>
    </div>
  );
}

function ConflictResolutionPreview(props: { conflict: ImportConflict; selected: boolean }) {
  return (
    <div className="grid min-w-0 gap-2 md:grid-cols-2">
      <ConflictSidePreview
        entry={props.conflict.existing}
        label="Ratel"
        state={props.selected ? "previous" : "next"}
      />
      <ConflictSidePreview
        entry={props.conflict.incoming}
        label="Agent"
        state={props.selected ? "next" : "unused"}
      />
    </div>
  );
}

function ConflictSidePreview(props: {
  entry: ServerEntry;
  label: string;
  state: "next" | "previous" | "unused";
}) {
  const isNext = props.state === "next";
  return (
    <div
      className={cn(
        "grid min-w-0 gap-1 border px-2.5 py-2",
        isNext ? "border-brand-green bg-brand-green/10" : "border-border bg-muted/25",
        props.state === "unused" ? "opacity-70" : undefined,
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="font-medium text-xs">{props.label}</span>
        {isNext ? <Check className="size-4 shrink-0 text-brand-green" aria-hidden="true" /> : null}
      </div>
      <dl className="grid min-w-0 gap-1 text-xs">
        <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">Transport</dt>
          <dd className="min-w-0 truncate font-mono">{entryTransport(props.entry)}</dd>
        </div>
        <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">{entryStartupLabel(props.entry)}</dt>
          <dd className="min-w-0 break-words font-mono">{entryStartupValue(props.entry)}</dd>
        </div>
      </dl>
    </div>
  );
}

function LinkedCoveredPreview(props: { flow: SetupFlow; host: DetectedAgentHostSummary }) {
  const isImport = props.flow === "import";
  return (
    <div className="grid gap-2 border border-emerald-300/70 bg-emerald-50 px-4 py-4 text-emerald-950 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-100">
      <div className="flex flex-wrap items-center gap-2">
        <LinkStatusBadge host={props.host} />
        <h4 className="font-medium">{isImport ? "No import needed" : "Already linked"}</h4>
      </div>
      <p className="text-sm text-emerald-800 dark:text-emerald-200">
        {isImport
          ? `${props.host.displayName} does not have native MCP tools missing from Ratel.`
          : `${props.host.displayName} is already routed through the Ratel gateway.`}
      </p>
    </div>
  );
}

function ChangeList(props: { changes: PlannedFileWrite[]; defaultOpen?: boolean; title: string }) {
  if (props.changes.length === 0) return null;
  const stats = props.changes.reduce(
    (total, change) => {
      const stat = diffStats(change);
      return { added: total.added + stat.added, removed: total.removed + stat.removed };
    },
    { added: 0, removed: 0 },
  );
  return (
    <div className="grid min-w-0 gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <GitCompare className="size-4" />
          {props.title}
        </h4>
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="text-emerald-700 dark:text-emerald-300">+{stats.added}</span>
          <span className="text-red-700 dark:text-red-300">-{stats.removed}</span>
        </div>
      </div>
      {props.changes.map((change) => (
        <details
          className="min-w-0 overflow-hidden border border-border bg-background"
          key={change.path}
          open={props.defaultOpen}
        >
          <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0 truncate font-mono text-xs">
              {change.path}
              {change.before === null ? " (new file)" : ""}
            </span>
            <DiffStatBadge change={change} />
          </summary>
          <UnifiedDiff change={change} />
        </details>
      ))}
    </div>
  );
}

type DiffRow =
  | { content: string; kind: "hunk"; newLine: null; oldLine: null }
  | {
      content: string;
      kind: "add" | "context" | "remove";
      newLine: number | null;
      oldLine: number | null;
    };

function UnifiedDiff(props: { change: PlannedFileWrite }) {
  const before = props.change.before ?? "";
  const patch = structuredPatch(
    props.change.path,
    props.change.path,
    before,
    props.change.after,
    "",
    "",
    {
      context: 4,
    },
  );
  const rows = patch.hunks.flatMap(diffRowsFromHunk);
  if (rows.length === 0) {
    return (
      <div className="border-border border-t px-3 py-6 text-sm text-muted-foreground">
        No line changes.
      </div>
    );
  }
  return (
    <div className="max-h-[32rem] max-w-full overflow-auto border-border border-t bg-muted/20">
      <DiffRowsTable rows={rows} />
    </div>
  );
}

function DiffRowsTable(props: { conflictSelection?: "agent" | "ratel"; rows: DiffRow[] }) {
  return (
    <table className="w-full table-fixed border-collapse font-mono text-xs">
      <colgroup>
        <col className="w-12" />
        <col className="w-12" />
        <col />
      </colgroup>
      <tbody>
        {props.rows.map((row) =>
          row.kind === "hunk" ? (
            <tr
              className={
                props.conflictSelection
                  ? "bg-muted text-muted-foreground"
                  : "bg-brand-green/10 text-brand-green"
              }
              key={diffRowKey(row)}
            >
              <td
                className={cn(
                  "select-none px-2 py-1 text-right",
                  props.conflictSelection ? "text-muted-foreground" : "text-brand-green/70",
                )}
              >
                ...
              </td>
              <td
                className={cn(
                  "select-none border-border border-r px-2 py-1 text-right",
                  props.conflictSelection ? "text-muted-foreground" : "text-brand-green/70",
                )}
              >
                ...
              </td>
              <td className="break-words px-2 py-1 whitespace-pre-wrap">{row.content}</td>
            </tr>
          ) : (
            <tr
              className={
                props.conflictSelection
                  ? conflictDiffRowClassName(row.kind, props.conflictSelection)
                  : diffRowClassName(row.kind)
              }
              key={diffRowKey(row)}
            >
              <td className="select-none px-2 py-0.5 text-right text-muted-foreground">
                {row.oldLine ?? ""}
              </td>
              <td className="select-none border-border border-r px-2 py-0.5 text-right text-muted-foreground">
                {row.newLine ?? ""}
              </td>
              <td className="px-2 py-0.5 whitespace-pre-wrap break-words">
                {props.conflictSelection ? null : (
                  <span className="mr-2 select-none text-muted-foreground">
                    {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
                  </span>
                )}
                {row.content.length > 0 ? row.content : " "}
              </td>
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

function DiffStatBadge(props: { change: PlannedFileWrite }) {
  const stats = diffStats(props.change);
  return (
    <span className="shrink-0 font-mono text-xs">
      <span className="text-emerald-700 dark:text-emerald-300">+{stats.added}</span>{" "}
      <span className="text-red-700 dark:text-red-300">-{stats.removed}</span>
    </span>
  );
}

function diffRowsFromHunk(hunk: StructuredPatchHunk): DiffRow[] {
  const rows: DiffRow[] = [
    {
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      kind: "hunk",
      newLine: null,
      oldLine: null,
    },
  ];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of hunk.lines) {
    const marker = line[0];
    const content = line.slice(1);
    if (marker === "+") {
      rows.push({ content, kind: "add", newLine, oldLine: null });
      newLine += 1;
      continue;
    }
    if (marker === "-") {
      rows.push({ content, kind: "remove", newLine: null, oldLine });
      oldLine += 1;
      continue;
    }
    if (marker === "\\") continue;
    rows.push({ content, kind: "context", newLine, oldLine });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

function diffStats(change: PlannedFileWrite) {
  const patch = structuredPatch(
    change.path,
    change.path,
    change.before ?? "",
    change.after,
    "",
    "",
    {
      context: 0,
    },
  );
  return patch.hunks.reduce(
    (total, hunk) => {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) total.added += 1;
        if (line.startsWith("-")) total.removed += 1;
      }
      return total;
    },
    { added: 0, removed: 0 },
  );
}

function diffRowClassName(kind: Exclude<DiffRow["kind"], "hunk">) {
  if (kind === "add") {
    return "bg-emerald-50 text-emerald-950 dark:bg-emerald-500/15 dark:text-emerald-100";
  }
  if (kind === "remove") {
    return "bg-red-50 text-red-950 dark:bg-red-500/15 dark:text-red-100";
  }
  return "bg-background";
}

function conflictDiffRowClassName(
  kind: Exclude<DiffRow["kind"], "hunk">,
  selection: "agent" | "ratel",
) {
  const kept =
    (selection === "agent" && kind === "add") || (selection === "ratel" && kind === "remove");
  if (kept) return "bg-muted text-foreground";
  if (kind === "add" || kind === "remove") return "bg-background text-muted-foreground opacity-70";
  return "bg-background";
}

function diffRowKey(row: DiffRow) {
  return `${row.kind}:${row.oldLine ?? ""}:${row.newLine ?? ""}:${row.content}`;
}

function LinkStatusBadge(props: { host: DetectedAgentHostSummary }) {
  if (props.host.posture === "unavailable") {
    return <StatusBadge tone="muted">Unavailable</StatusBadge>;
  }
  if (props.host.connection.kind === "duplicate") {
    return <StatusBadge tone="warning">Duplicate connection</StatusBadge>;
  }
  if (props.host.connection.kind === "plugin") {
    return <StatusBadge tone="success">Linked via plugin</StatusBadge>;
  }
  if (props.host.connection.linked) {
    return <StatusBadge tone="success">Linked</StatusBadge>;
  }
  return <StatusBadge tone="muted">Not linked</StatusBadge>;
}

function ClaudeStatuslineStatus(props: { state: ClaudeStatuslineState }) {
  if (props.state.status === "installed") {
    return <AgentStatusText tone="success">Installed</AgentStatusText>;
  }
  if (props.state.status === "other") {
    return <AgentStatusText tone="warning">Other configured</AgentStatusText>;
  }
  return <AgentStatusText tone="muted">Not installed</AgentStatusText>;
}

function StatusBadge(props: { children: React.ReactNode; tone: "muted" | "success" | "warning" }) {
  const toneClass =
    props.tone === "success"
      ? "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
      : props.tone === "warning"
        ? "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200"
        : "border-border bg-muted text-muted-foreground";
  const dotClass =
    props.tone === "success"
      ? "bg-emerald-500"
      : props.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground/50";
  return (
    <Badge className={cn("gap-1.5 rounded-full px-2 font-medium", toneClass)} variant="outline">
      <span className={cn("size-1.5 rounded-full", dotClass)} />
      {props.children}
    </Badge>
  );
}

function missingRatelEntryNames(host: DetectedAgentHostSummary): string[] {
  return host.missingRatelEntryNames ?? [];
}

function AgentIcon(props: { kind: AgentHostKind; size?: "md" | "lg" }) {
  const className = props.size === "lg" ? "size-16" : "size-12";
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-md border border-border bg-background",
        className,
      )}
    >
      {props.kind === "claude-code" ? <ClaudeMark /> : <CodexMark />}
    </div>
  );
}

function AgentIconFrame(props: { kind: AgentHostKind }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded border border-border bg-background">
      {props.kind === "claude-code" ? (
        <ClaudeMark className="size-3.5" />
      ) : (
        <CodexMark className="size-3.5" />
      )}
    </span>
  );
}

function ClaudeMark(props: { className?: string } = {}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("size-2/3", props.className)}
      src={CLAUDE_CODE_ICON_SRC}
    />
  );
}

function CodexMark(props: { className?: string } = {}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("size-2/3", props.className)}
      src={CODEX_ICON_SRC}
    />
  );
}

function preferredHostKind(hosts: readonly DetectedAgentHostSummary[]): AgentHostKind {
  return hosts.find((host) => host.detection.present)?.kind ?? hosts[0]?.kind ?? "claude-code";
}

function agentDisplayName(kind: AgentHostKind): string {
  return kind === "claude-code" ? "Claude Code" : "Codex";
}

function toggleSelection(current: readonly string[], value: string): string[] {
  const next = new Set(current);
  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }
  return [...next].sort();
}

function summarizeEntry(entry: ServerEntry): string {
  if (entry.type === "http" || entry.type === "sse") {
    return `${entry.type} ${entry.url ?? "(missing url)"}`;
  }
  const command = entry.command ?? "(missing command)";
  const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
  return `${entry.type ?? "stdio"} ${command}${args}`;
}

function entryTransport(entry: ServerEntry): string {
  return entry.type ?? "stdio";
}

function entryStartupLabel(entry: ServerEntry): string {
  return entry.type === "http" || entry.type === "sse" ? "URL" : "Command";
}

function entryStartupValue(entry: ServerEntry): string {
  if (entry.type === "http" || entry.type === "sse") return entry.url ?? "(missing url)";
  const command = entry.command ?? "(missing command)";
  return entry.args && entry.args.length > 0 ? `${command} ${entry.args.join(" ")}` : command;
}

function serializeEntryForDiff(entry: ServerEntry): string {
  return `${JSON.stringify(sortJsonValue(entry), null, 2)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
