import { useNavigate } from "@tanstack/react-router";
import { type StructuredPatchHunk, structuredPatch } from "diff";
import {
  ArrowLeft,
  Check,
  Download,
  FileText,
  GitCompare,
  LinkIcon,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import useMeasure from "react-use-measure";
import { type BackupManifest, type JsonRequestInit, type ServerEntry, useRatelApp } from "@/App";
import {
  AgentCountLabel,
  AgentCoverageLabel,
  AgentIcon,
  AgentIconFrame,
  agentColor,
  agentDisplayName,
  ClaudeStatuslineBadge,
  LinkStatusBadge,
  POSTURE_COPY,
  StatusBadge,
} from "@/components/agent-identity";
import { SkillImportPicker, skillKey } from "@/components/import-skills-dialog";
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
} from "@/components/responsive-toolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DetailGrid, DetailLabel } from "@/components/ui/detail-grid";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type AgentScope,
  agentHostsFromResponse,
  type ClaudeStatuslineState,
  type DetectedAgentHostSummary,
  missingRatelEntryNames,
  preferredHostKind,
} from "@/lib/agent-hosts";
import {
  type AgentHostKind,
  availableSkillsForKind,
  fetchSkills,
  type SkillSummary,
} from "@/lib/skills";
import { cn } from "@/lib/utils";

type ConflictStrategy = "add-missing-only" | "replace-from-agent" | "replace-selected";
type SetupFlow = "import" | "link";

interface AgentCandidate {
  name: string;
  scope: AgentScope;
  entry: ServerEntry;
}

interface FileChange {
  kind: "write";
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

export interface AgentPlanPreview {
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  candidates: AgentCandidate[];
  selected: string[];
  plan: {
    ratelChanges: FileChange[];
    agentChanges: FileChange[];
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
  stageHashes: { ratel: string; agent: string };
  emptyReason: string | null;
}

const AGENT_ROW_GRID = "lg:grid-cols-[minmax(14rem,1.1fr)_7rem_7rem_7rem_11rem_10rem]";
const BACKUP_ROW_GRID = "lg:grid-cols-[minmax(14rem,1fr)_8rem_10rem_minmax(12rem,1fr)]";

/**
 * Load the unmanaged skills available across agents (those Ratel doesn't manage
 * yet). Shared by the agent directory (for per-card counts) and the agent detail
 * page (for the import section). Fail-soft to an empty list so a skills hiccup
 * never blocks the MCP setup flows.
 */
export function useAvailableSkills() {
  const { request } = useRatelApp();
  const [available, setAvailable] = useState<SkillSummary[]>([]);
  const reload = useCallback(async () => {
    try {
      const data = await fetchSkills(request);
      setAvailable(data.available);
    } catch {
      setAvailable([]);
    }
  }, [request]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { available, reload };
}

export function AgentSetupPage() {
  const { clearSetupIntent, config, refresh, request, setupIntent, token } = useRatelApp();
  const navigate = useNavigate();
  const { available } = useAvailableSkills();
  const [hosts, setHosts] = useState<DetectedAgentHostSummary[]>([]);
  const [scanning, setScanning] = useState(false);
  const handledIntent = useRef<number | null>(null);
  const backups = config?.backups ?? [];

  const scanHosts = useCallback(async () => {
    setScanning(true);
    try {
      const body = await request<unknown>("/api/agent-hosts");
      setHosts(agentHostsFromResponse(body));
    } catch {
      setHosts([]);
    } finally {
      setScanning(false);
    }
  }, [request]);

  const openAgent = useCallback(
    (kind: AgentHostKind, operation?: SetupFlow) => {
      const search = new URLSearchParams();
      if (token) search.set("t", token);
      if (operation) search.set("operation", operation);
      void navigate({ to: `/agent-setup/${kind}?${search.toString()}` } as never);
    },
    [navigate, token],
  );
  useEffect(() => {
    void scanHosts();
  }, [scanHosts]);

  useEffect(() => {
    if (setupIntent && handledIntent.current !== setupIntent.id) {
      handledIntent.current = setupIntent.id;
      openAgent(preferredHostKind(hosts), setupIntent.kind);
      clearSetupIntent();
    }
  }, [clearSetupIntent, hosts, openAgent, setupIntent]);

  return (
    <main className="grid w-full gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Agent Setup</PageHeaderTitle>
            <div className="flex items-center gap-1 sm:hidden">
              <Button
                aria-label="Refresh"
                disabled={scanning}
                onClick={() => void Promise.all([refresh(), scanHosts()])}
                size="icon-lg"
                type="button"
                variant="outline"
              >
                <RefreshCw className={cn(scanning && "animate-spin")} />
                <span className="sr-only">Refresh</span>
              </Button>
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription className="max-w-sm sm:max-w-2xl">
            Inspect supported agent configs, then open an agent to import or link MCP entries.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden sm:flex">
          <ResponsiveToolbar>
            <ResponsiveToolbarGroup>
              <ResponsiveToolbarButton
                disabled={scanning}
                icon={<RefreshCw className={cn(scanning && "animate-spin")} />}
                kbd="⌘R"
                label="Refresh"
                onClick={() => void Promise.all([refresh(), scanHosts()])}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      <section className="-mx-4 overflow-hidden border-border border-y sm:-mx-6">
        <div
          className={cn(
            "hidden gap-3 border-border border-b bg-muted/30 px-4 py-2 font-mono text-xs text-muted-foreground uppercase sm:px-6 lg:grid",
            AGENT_ROW_GRID,
          )}
        >
          <span>Agent</span>
          <span className="text-right">Native</span>
          <span className="text-right">Ratel</span>
          <span className="text-right">Skills</span>
          <span className="text-right">Coverage</span>
          <span>Status</span>
        </div>
        <div className="divide-border divide-y">
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

      <Backups backups={backups} />
    </main>
  );
}

export function AgentDetailPage(props: { kind: AgentHostKind; operation?: SetupFlow }) {
  const { refresh, request, token } = useRatelApp();
  const navigate = useNavigate();
  const { available, reload: reloadSkills } = useAvailableSkills();
  const agentAvailable = availableSkillsForKind(available, props.kind);
  const [hosts, setHosts] = useState<DetectedAgentHostSummary[]>([]);
  const [scanning, setScanning] = useState(false);

  const scanHosts = useCallback(async () => {
    setScanning(true);
    try {
      const body = await request<unknown>("/api/agent-hosts");
      setHosts(agentHostsFromResponse(body));
    } catch {
      setHosts([]);
    } finally {
      setScanning(false);
    }
  }, [request]);

  useEffect(() => {
    void scanHosts();
  }, [scanHosts]);

  const host = hosts.find((item) => item.kind === props.kind);
  const goBack = () => {
    const target = token ? `/agent-setup?t=${encodeURIComponent(token)}` : "/agent-setup";
    void navigate({ to: target } as never);
  };
  const switchHost = (kind: AgentHostKind) => {
    const search = new URLSearchParams();
    if (token) search.set("t", token);
    void navigate({ to: `/agent-setup/${kind}?${search.toString()}` } as never);
  };
  const primaryPath = host?.scopes.find((scope) => scope.available)?.path ?? host?.scopes[0]?.path;

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Agents
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
                <RefreshCw className={cn(scanning && "animate-spin")} />
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
                icon={<RefreshCw className={cn(scanning && "animate-spin")} />}
                kbd="⌘R"
                label="Refresh"
                onClick={() => void Promise.all([refresh(), scanHosts()])}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      {host ? (
        <section className="grid gap-5">
          <DetailGrid>
            <DetailLabel>Host</DetailLabel>
            <div className="flex min-w-0 items-center gap-2">
              <AgentIcon kind={host.kind} />
              <span className="font-medium">{host.displayName}</span>
            </div>
            <DetailLabel>Status</DetailLabel>
            <LinkStatusBadge host={host} />
            {host.kind === "claude-code" && host.statusline ? (
              <>
                <DetailLabel>Statusline</DetailLabel>
                <ClaudeStatuslineBadge state={host.statusline} />
                <DetailLabel>Ratel MCP</DetailLabel>
                <StatusBadge tone={host.statusline.ratelEnabled ? "success" : "warning"}>
                  {host.statusline.ratelEnabled ? "Enabled" : "Not enabled"}
                </StatusBadge>
              </>
            ) : null}
            {missingRatelEntryNames(host).length > 0 || agentAvailable.length > 0 ? (
              <>
                <DetailLabel>Coverage</DetailLabel>
                <div className="grid gap-1">
                  {missingRatelEntryNames(host).length > 0 ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {missingRatelEntryNames(host).length} native tool
                      {missingRatelEntryNames(host).length === 1 ? "" : "s"} not in Ratel.
                    </p>
                  ) : null}
                  {agentAvailable.length > 0 ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      {agentAvailable.length} skill{agentAvailable.length === 1 ? "" : "s"} not
                      managed by Ratel.
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
            <DetailLabel>Config</DetailLabel>
            <code className="min-w-0 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground">
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
      <SelectContent align="end" alignItemWithTrigger={false} className="min-w-56">
        {props.hosts.map((host) => (
          <SelectItem key={host.kind} value={host.kind}>
            <AgentIconFrame kind={host.kind} />
            <span>{host.displayName}</span>
            <LinkStatusBadge host={host} />
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
  const color = agentColor(props.host.kind);
  const missingNativeCount = missingRatelEntryNames(props.host).length;
  const coverageTotal = props.host.ratelEntryCount + missingNativeCount;
  const coverageValue = props.host.ratelEntryCount;

  return (
    <div
      className={cn(
        "relative grid gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/30 sm:px-6 lg:grid lg:items-center",
        AGENT_ROW_GRID,
      )}
    >
      <button
        aria-label={`Open ${props.host.displayName}`}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
        onClick={props.onOpen}
        type="button"
      />

      <div className="relative z-20 grid min-w-0 gap-3 lg:hidden">
        <div className="pointer-events-none flex min-w-0 items-start gap-3">
          <AgentIcon kind={props.host.kind} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="min-w-0 truncate font-semibold tracking-tight">
                {props.host.displayName}
              </h4>
            </div>
            <p className="mt-1 line-clamp-2 text-muted-foreground">{posture.description}</p>
            <p className="mt-2 truncate font-mono text-xs text-muted-foreground">
              {primaryPath ?? props.host.detection.reasons[0] ?? "Known paths unavailable"}
            </p>
          </div>
        </div>
        <div className="pointer-events-none grid min-w-0 grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs text-muted-foreground uppercase">Native</span>
          <AgentCountLabel count={props.host.nativeEntryCount} label="tools" />
          <span className="font-mono text-xs text-muted-foreground uppercase">Ratel</span>
          <AgentCountLabel count={props.host.ratelEntryCount} label="entries" />
          <span className="font-mono text-xs text-muted-foreground uppercase">Skills</span>
          <AgentCountLabel count={props.unmanagedSkillCount} label="unmanaged" tone="warning" />
          <span className="font-mono text-xs text-muted-foreground uppercase">Coverage</span>
          <AgentCoverageLabel color={color} total={coverageTotal} value={coverageValue} />
          <span className="font-mono text-xs text-muted-foreground uppercase">Status</span>
          <LinkStatusBadge host={props.host} />
        </div>
      </div>

      <div className="pointer-events-none relative z-20 hidden min-w-0 lg:block">
        <div className="flex min-w-0 items-center gap-3">
          <AgentIcon kind={props.host.kind} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h4 className="min-w-0 truncate font-semibold tracking-tight">
                {props.host.displayName}
              </h4>
            </div>
            <p className="mt-1 line-clamp-1 text-muted-foreground">{posture.description}</p>
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {primaryPath ?? props.host.detection.reasons[0] ?? "Known paths unavailable"}
            </p>
          </div>
        </div>
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 text-right lg:block">
        <AgentCountLabel count={props.host.nativeEntryCount} label="tools" />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 text-right lg:block">
        <AgentCountLabel count={props.host.ratelEntryCount} label="entries" />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 text-right lg:block">
        <AgentCountLabel count={props.unmanagedSkillCount} label="unmanaged" tone="warning" />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 lg:flex lg:items-center lg:justify-end">
        <AgentCoverageLabel color={color} total={coverageTotal} value={coverageValue} />
      </div>
      <div className="pointer-events-none relative z-20 hidden lg:block">
        <LinkStatusBadge host={props.host} />
      </div>
    </div>
  );
}

export function AgentOperationPanel(props: {
  availableSkills: SkillSummary[];
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onApplied?: () => void;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const canImport =
    missingRatelEntryNames(props.host).length > 0 || props.availableSkills.length > 0;
  const canLink = props.host.posture !== "unavailable" && props.host.ratelEntryCount === 0;
  const canManageStatusline = props.hostKind === "claude-code" && Boolean(props.host.statusline);
  return (
    <section className="-mx-4 grid gap-5 border-border border-y bg-muted/10 px-4 py-5 sm:-mx-6 sm:px-6">
      {props.hostKind === "claude-code" && props.host.statusline ? (
        <ClaudeStatuslineSection
          onScanHosts={props.onScanHosts}
          request={props.request}
          state={props.host.statusline}
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
            onApplied={props.onApplied}
            onScanHosts={props.onScanHosts}
            onSkillsImported={props.onSkillsImported}
            request={props.request}
          />
        </SetupActionSection>
      ) : null}
      {canLink ? (
        <SetupActionSection
          description="Add the Ratel gateway entry when this agent is not routed through Ratel yet."
          title="Link Ratel gateway"
        >
          <PreviewFlow
            availableSkills={[]}
            flow="link"
            host={props.host}
            hostKind={props.hostKind}
            key={`link:${props.hostKind}`}
            onApplied={props.onApplied}
            onScanHosts={props.onScanHosts}
            onSkillsImported={props.onSkillsImported}
            request={props.request}
          />
        </SetupActionSection>
      ) : null}
      {!canImport && !canLink && !canManageStatusline ? (
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Nothing to do</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            This agent is linked, all native entries are already in Ratel, and every skill is
            managed through Ratel.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function ClaudeStatuslineSection(props: {
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  state: ClaudeStatuslineState;
}) {
  const { runAction } = useRatelApp();
  const installed = props.state.status === "installed";
  const otherConfigured = props.state.status === "other";
  const actionLabel = installed
    ? "Uninstall statusline"
    : otherConfigured
      ? "Replace statusline"
      : "Install statusline";
  const description = installed
    ? "Remove the Ratel-owned statusLine command from Claude Code."
    : otherConfigured
      ? "Replace the existing Claude Code statusLine command with Ratel's statusline."
      : "Show Claude context usage, Ratel enablement, and Ratel tool telemetry in the statusline.";

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
    <SetupActionSection description={description} title={actionLabel}>
      <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="font-medium text-sm">Context and Ratel telemetry at a glance</p>
          <p className="mt-1 max-w-xl text-muted-foreground text-xs">
            Shows model, context-window usage, session duration, git branch, whether Ratel is
            enabled, and the estimated tool tokens/tool count Ratel keeps out of Claude's prompt.
          </p>
          {!props.state.ratelEnabled ? (
            <p className="mt-2 max-w-xl text-amber-700 text-xs dark:text-amber-400">
              Ratel is not enabled in Claude Code yet, so the statusline will report that until the
              gateway is linked or the plugin is enabled.
            </p>
          ) : null}
        </div>
        <Button
          className="min-h-12 px-6 text-base md:min-w-44"
          onClick={() => void commit()}
          variant={installed ? "outline" : "default"}
        >
          {installed ? <X /> : <FileText />}
          {actionLabel}
        </Button>
      </div>
    </SetupActionSection>
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

/**
 * The apply sequence for a preview: write Ratel config, rewrite/link the agent config, and
 * activate selected skills — each via `runAction` (notify + refresh) and followed by a host
 * rescan. Returns whether every step succeeded. Consumers own their own post-apply UI (the
 * dialog reloads its preview; the onboarding flow advances to success). Shared by
 * `PreviewFlow` and the guided onboarding `SetupFlow`.
 */
export function useAgentApply(props: {
  hostKind: AgentHostKind;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const { runAction } = useRatelApp();

  const applyRatel = async (
    importPreview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
  ) => {
    const applied = await runAction("Ratel config changes applied", () =>
      props.request("/api/agent-apply/import/ratel", {
        method: "POST",
        body: {
          hostKind: props.hostKind,
          selection: importPreview.selected,
          conflictStrategy,
          replaceConflicts,
          planHash: importPreview.stageHashes.ratel,
        },
      }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    return true;
  };

  const applyAgent = async (
    activePreview: AgentPlanPreview,
    flow: SetupFlow,
    options?: { conflictStrategy?: ConflictStrategy; replaceConflicts?: string[] },
  ) => {
    const path = flow === "import" ? "/api/agent-apply/import/agent" : "/api/agent-apply/link";
    const applied = await runAction(
      flow === "import" ? "Agent config rewritten" : "Link complete",
      () =>
        props.request(path, {
          method: "POST",
          body: {
            hostKind: props.hostKind,
            selection: flow === "import" ? activePreview.selected : undefined,
            conflictStrategy: flow === "import" ? options?.conflictStrategy : undefined,
            replaceConflicts: flow === "import" ? options?.replaceConflicts : undefined,
            planHash: activePreview.stageHashes.agent,
          },
        }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    return true;
  };

  const activateSelectedSkills = async (selectedSkills: SkillSummary[]) => {
    const idsBySource = new Map<SkillSummary["source"], string[]>();
    for (const skill of selectedSkills) {
      if (skill.source !== "claude" && skill.source !== "codex") continue;
      const ids = idsBySource.get(skill.source) ?? [];
      ids.push(skill.id);
      idsBySource.set(skill.source, ids);
    }
    const applied = await runAction(
      `Now managing ${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"}`,
      async () => {
        for (const [source, ids] of idsBySource) {
          await props.request("/api/skills/activate", { method: "POST", body: { ids, source } });
        }
      },
    );
    if (!applied) return false;
    await props.onSkillsImported();
    return true;
  };

  const commitImport = async (
    importPreview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => {
    if (importPreview.plan.ratelChanges.length > 0) {
      if (!(await applyRatel(importPreview, conflictStrategy, replaceConflicts))) return false;
    }
    if (importPreview.plan.agentChanges.length > 0) {
      if (!(await applyAgent(importPreview, "import", { conflictStrategy, replaceConflicts }))) {
        return false;
      }
    }
    if (selectedSkills.length > 0) {
      if (!(await activateSelectedSkills(selectedSkills))) return false;
    }
    return true;
  };

  const commitLink = async (linkPreview: AgentPlanPreview) => {
    if (linkPreview.plan.agentChanges.length > 0) {
      if (!(await applyAgent(linkPreview, "link"))) return false;
    }
    return true;
  };

  return { commitImport, commitLink };
}

function PreviewFlow(props: {
  availableSkills: SkillSummary[];
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onApplied?: () => void;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const { commitImport: applyImport, commitLink: applyLink } = useAgentApply({
    hostKind: props.hostKind,
    onScanHosts: props.onScanHosts,
    onSkillsImported: props.onSkillsImported,
    request: props.request,
  });
  const [preview, setPreview] = useState<AgentPlanPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const endpoint =
    props.flow === "import" ? "/api/agent-preview/import" : "/api/agent-preview/link";
  const previewPath = `${endpoint}?r=${refreshNonce}`;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const body = await props.request<AgentPlanPreview>(previewPath, {
          method: "POST",
          body: {
            hostKind: props.hostKind,
          },
        });
        if (cancelled) return;
        setPreview(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [previewPath, props.hostKind, props.request]);

  const linkedAndCovered =
    props.host.ratelEntryCount > 0 && missingRatelEntryNames(props.host).length === 0;
  const friendlyNoOp = Boolean(
    preview?.emptyReason && linkedAndCovered && props.availableSkills.length === 0,
  );

  const afterApply = () => {
    setDialogOpen(false);
    setRefreshNonce((value) => value + 1);
    props.onApplied?.();
  };

  const commitImport = async (
    importPreview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => {
    const ok = await applyImport(importPreview, conflictStrategy, replaceConflicts, selectedSkills);
    if (!ok) return false;
    afterApply();
    return true;
  };

  const commitLink = async () => {
    if (!preview) return false;
    const ok = await applyLink(preview);
    if (!ok) return false;
    afterApply();
    return true;
  };

  return (
    <div className="grid gap-4">
      {loading && !preview ? (
        <div className="rounded-md border border-border px-3 py-6 text-sm text-muted-foreground">
          Building preview...
        </div>
      ) : null}

      {preview ? (
        <>
          {friendlyNoOp ? (
            <LinkedCoveredPreview flow={props.flow} host={props.host} />
          ) : (
            <SetupRecap
              availableSkills={props.availableSkills}
              flow={props.flow}
              onOpen={() => setDialogOpen(true)}
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
              onOpenChange={setDialogOpen}
              open={dialogOpen}
              preview={preview}
              request={props.request}
              hostKind={props.hostKind}
              skills={props.availableSkills}
            />
          ) : null}
          {!friendlyNoOp && props.flow === "link" ? (
            <LinkSceneDialog
              onCommit={commitLink}
              onOpenChange={setDialogOpen}
              open={dialogOpen}
              preview={preview}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Backups(props: { backups: BackupManifest[] }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-col gap-2 px-1 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-medium">Backups</h3>
          <p className="text-sm text-muted-foreground">
            Recent changes created by import, link, and other config writes.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {props.backups.length} backup{props.backups.length === 1 ? "" : "s"}
        </p>
      </div>
      {props.backups.length === 0 ? (
        <div className="-mx-4 border-border border-y bg-muted/15 px-4 py-6 text-sm text-muted-foreground sm:-mx-6 sm:px-6">
          No backups yet.
        </div>
      ) : (
        <div className="-mx-4 overflow-hidden border-border border-y sm:-mx-6">
          <div
            className={cn(
              "hidden gap-3 border-border border-b bg-muted/30 px-4 py-2 font-mono text-xs text-muted-foreground uppercase sm:px-6 lg:grid",
              BACKUP_ROW_GRID,
            )}
          >
            <span>Backup</span>
            <span className="text-right">Files</span>
            <span className="text-right">Created</span>
            <span>Paths</span>
          </div>
          <div className="divide-border divide-y">
            {props.backups.map((backup, index) => (
              <BackupRow
                backup={backup}
                key={`${backup.createdAt}-${backup.action}`}
                latest={index === 0}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function BackupRow(props: { backup: BackupManifest; latest: boolean }) {
  const paths = props.backup.entries.map((entry) => entry.originalPath).join(", ");
  return (
    <div
      className={cn(
        "grid gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/30 sm:px-6 lg:grid lg:items-center",
        BACKUP_ROW_GRID,
        props.latest && "bg-muted/25",
      )}
    >
      <div className="grid min-w-0 gap-2 lg:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate font-medium">{restoreActionLabel(props.backup.action)}</p>
          <BackupFreshnessBadge latest={props.latest} />
        </div>
        <div className="grid min-w-0 grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs text-muted-foreground uppercase">Files</span>
          <BackupFileCount count={props.backup.entries.length} />
          <span className="font-mono text-xs text-muted-foreground uppercase">Created</span>
          <span className="text-right font-mono text-xs">
            {restoreCreatedLabel(props.backup.createdAt)}
          </span>
          <span className="font-mono text-xs text-muted-foreground uppercase">Paths</span>
          <p className="truncate rounded-md bg-muted/50 px-2 py-1.5 font-mono text-right text-xs text-muted-foreground">
            {paths}
          </p>
        </div>
      </div>

      <div className="hidden min-w-0 lg:block">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate font-medium">{restoreActionLabel(props.backup.action)}</p>
          <BackupFreshnessBadge latest={props.latest} />
        </div>
      </div>
      <div className="hidden min-w-0 text-right lg:block">
        <BackupFileCount count={props.backup.entries.length} />
      </div>
      <span className="hidden text-right font-mono text-xs lg:block">
        {restoreCreatedLabel(props.backup.createdAt)}
      </span>
      <p className="hidden truncate rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs text-muted-foreground lg:block">
        {paths}
      </p>
    </div>
  );
}

function BackupFreshnessBadge(props: { latest: boolean }) {
  if (!props.latest) return null;

  return (
    <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-foreground text-xs">
      Latest
    </span>
  );
}

function BackupFileCount(props: { count: number }) {
  return (
    <span className="block truncate text-right font-mono text-xs">
      {props.count} file{props.count === 1 ? "" : "s"}
    </span>
  );
}

const RESTORE_ACTION_LABELS: Record<BackupManifest["action"], string> = {
  add: "Added tool source",
  edit: "Edited tool source",
  import: "Imported agent sources",
  link: "Linked agent config",
  remove: "Removed tool source",
};

function restoreActionLabel(action: BackupManifest["action"]) {
  return RESTORE_ACTION_LABELS[action] ?? action;
}

function restoreCreatedLabel(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return date.toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  });
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
            : "One agent config change will be reviewed before writing."}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          {props.flow === "import"
            ? "Skills are selected first; MCP conflict handling follows only when needed."
            : "Native MCP entries are preserved."}
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

// --- Import/link scene bodies -------------------------------------------------
// Content-only components (no footer/chrome) shared by the ImportSceneDialog on the
// Agent Setup page and the guided onboarding SetupFlow. Each renders one scene.

export function ImportSkillsScene(props: {
  onToggle: (skill: SkillSummary) => void;
  onToggleAll: (skills: SkillSummary[], shouldSelect: boolean) => void;
  resetKey: string;
  selected: Set<string>;
  skills: SkillSummary[];
}) {
  return (
    <div className="grid gap-3">
      {props.skills.length > 0 ? (
        <div className="grid">
          <SkillImportPicker
            className="[&_[data-skill-scroll]]:max-h-72"
            flushScroll
            onToggle={props.onToggle}
            onToggleAll={props.onToggleAll}
            resetKey={props.resetKey}
            selected={props.selected}
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
  );
}

export function ImportEntriesScene(props: {
  candidates: AgentCandidate[];
  onToggle: (name: string) => void;
  selected: Set<string>;
}) {
  if (props.candidates.length === 0) return null;
  return (
    <SceneScrollSection className="max-h-72">
      {props.candidates.map((candidate) => {
        const isSelected = props.selected.has(candidate.name);
        return (
          <button
            className={cn(
              "grid w-full gap-1 border-border border-b px-3 py-2 text-left transition-colors last:border-b-0",
              isSelected ? "bg-brand-green/10" : "bg-background hover:bg-muted/35",
            )}
            key={`${candidate.scope}:${candidate.name}`}
            onClick={() => props.onToggle(candidate.name)}
            type="button"
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <Checkbox checked={isSelected} className="pointer-events-none" tabIndex={-1} />
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
  );
}

export function ImportStrategyScene(props: {
  onChange: (strategy: ConflictStrategy) => void;
  strategy: ConflictStrategy;
}) {
  return (
    <div className="grid gap-2">
      <ConflictStrategyButton
        active={props.strategy === "add-missing-only"}
        detail="Leave existing Ratel entries unchanged and import only new names."
        label="Import new only"
        onClick={() => props.onChange("add-missing-only")}
      />
      <ConflictStrategyButton
        active={props.strategy === "replace-from-agent"}
        detail="Use the agent version for every matching name."
        label="Use all agent versions"
        onClick={() => props.onChange("replace-from-agent")}
      />
      <ConflictStrategyButton
        active={props.strategy === "replace-selected"}
        detail="Pick which matching names should use the agent version."
        label="Choose per entry"
        onClick={() => props.onChange("replace-selected")}
      />
    </div>
  );
}

export function ImportConflictsScene(props: {
  conflicts: ImportConflict[];
  onToggleReplace: (key: string) => void;
  replaceConflicts: Set<string>;
}) {
  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Selected entries will overwrite the matching Ratel entry. Unselected entries keep the
        current Ratel version.
      </p>
      <SceneScrollSection className="grid max-h-80 gap-2">
        <ConflictPickList
          conflicts={props.conflicts}
          onToggleReplace={props.onToggleReplace}
          replaceConflicts={props.replaceConflicts}
        />
      </SceneScrollSection>
    </div>
  );
}

export function ImportReviewScene(props: {
  hostDisplayName: string;
  preview: AgentPlanPreview;
  selectedSkills: SkillSummary[];
}) {
  return (
    <SceneScrollSection className="grid max-h-[65vh] gap-4">
      <ChangeList changes={props.preview.plan.ratelChanges} defaultOpen title="Ratel config" />
      <ChangeList
        changes={props.preview.plan.agentChanges}
        defaultOpen
        title={`${props.hostDisplayName} config`}
      />
      <SkillActivationReview skills={props.selectedSkills} />
    </SceneScrollSection>
  );
}

export function LinkReviewScene(props: { preview: AgentPlanPreview }) {
  return (
    <SceneScrollSection className="max-h-[65vh]">
      <ChangeList
        changes={props.preview.plan.agentChanges}
        defaultOpen
        title={`${props.preview.host.displayName} changes`}
      />
    </SceneScrollSection>
  );
}

export type ImportScene = "skills" | "entries" | "strategy" | "pick-conflicts" | "review";

/**
 * Owns the import draft: the working selection/skill/conflict state, the preview that is
 * re-fetched from `/api/agent-preview/import` as those change, and the derived flags +
 * ordered `activeScenes` list. Shared by the ImportSceneDialog (Agent Setup page) and the
 * guided onboarding SetupFlow so both drive the exact same state machine.
 */
export function useImportDraft(props: {
  active: boolean;
  hostKind: AgentHostKind;
  preview: AgentPlanPreview;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  skills: SkillSummary[];
}) {
  const [draftPreview, setDraftPreview] = useState<AgentPlanPreview>(props.preview);
  const [draftSelection, setDraftSelection] = useState<string[]>(props.preview.selected);
  const [draftSkillSelection, setDraftSkillSelection] = useState<Set<string>>(new Set());
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>("add-missing-only");
  const [replaceConflicts, setReplaceConflicts] = useState<string[]>([]);

  const selected = new Set(draftSelection);
  const selectedSkills = props.skills.filter((skill) => draftSkillSelection.has(skillKey(skill)));
  const conflicts = draftPreview.plan.summary.conflicts;
  const requiresConflictSelection =
    draftSelection.length > 0 && conflicts.length > 0 && conflictStrategy === "replace-selected";
  const hasSelectedImport = draftSelection.length > 0 || selectedSkills.length > 0;
  const hasSelectableEntries = props.preview.candidates.length > 0;
  const canLeaveSkills = selectedSkills.length > 0 || hasSelectableEntries;

  useEffect(() => {
    if (!props.active) return;
    setDraftPreview(props.preview);
    setDraftSelection(props.preview.selected);
    setDraftSkillSelection(new Set());
    setConflictStrategy("add-missing-only");
    setReplaceConflicts([]);
  }, [props.active, props.preview]);

  useEffect(() => {
    if (!props.active) return;
    let cancelled = false;
    const loadDraftPreview = async () => {
      const body = await props.request<AgentPlanPreview>("/api/agent-preview/import", {
        method: "POST",
        body: {
          hostKind: props.hostKind,
          selection: draftSelection,
          conflictStrategy,
          replaceConflicts,
        },
      });
      if (!cancelled) setDraftPreview(body);
    };
    void loadDraftPreview();
    return () => {
      cancelled = true;
    };
  }, [
    conflictStrategy,
    draftSelection,
    props.active,
    props.hostKind,
    props.request,
    replaceConflicts,
  ]);

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

  const toggleEntry = (name: string) =>
    setDraftSelection((current) => toggleSelection(current, name));
  const toggleReplaceConflict = (key: string) =>
    setReplaceConflicts((current) => toggleSelection(current, key));

  // Ordered list of scenes that actually apply given the current selection/conflicts.
  // (An empty Skills scene is dropped so guided consumers don't show a dead step.)
  const activeScenes: ImportScene[] = [];
  if (props.skills.length > 0) activeScenes.push("skills");
  if (hasSelectableEntries) activeScenes.push("entries");
  if (draftSelection.length > 0 && conflicts.length > 0) activeScenes.push("strategy");
  if (requiresConflictSelection) activeScenes.push("pick-conflicts");
  activeScenes.push("review");

  return {
    activeScenes,
    canLeaveSkills,
    conflicts,
    conflictStrategy,
    draftPreview,
    draftSelection,
    draftSkillSelection,
    hasSelectableEntries,
    hasSelectedImport,
    replaceConflicts,
    requiresConflictSelection,
    selected,
    selectedSkills,
    setConflictStrategy,
    setDraftSelection,
    setReplaceConflicts,
    toggleEntry,
    toggleReplaceConflict,
    toggleSkill,
    toggleSkills,
  };
}

function ImportSceneDialog(props: {
  hostKind: AgentHostKind;
  onCommit: (
    preview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  preview: AgentPlanPreview;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  skills: SkillSummary[];
}) {
  const [scene, setScene] = useState<ImportScene>("skills");
  const [committing, setCommitting] = useState(false);
  const {
    canLeaveSkills,
    conflicts,
    conflictStrategy,
    draftPreview,
    draftSelection,
    draftSkillSelection,
    hasSelectableEntries,
    hasSelectedImport,
    replaceConflicts,
    requiresConflictSelection,
    selected,
    selectedSkills,
    setConflictStrategy,
    setDraftSelection,
    setReplaceConflicts,
    toggleSkill,
    toggleSkills,
  } = useImportDraft({
    active: props.open,
    hostKind: props.hostKind,
    preview: props.preview,
    request: props.request,
    skills: props.skills,
  });

  const goAfterSkills = () => setScene(hasSelectableEntries ? "entries" : "review");
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

  const commit = async () => {
    setCommitting(true);
    try {
      await props.onCommit(draftPreview, conflictStrategy, replaceConflicts, selectedSkills);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <SceneDialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (open) setScene("skills");
      }}
      scene={scene}
      title="Import"
    >
      {scene === "skills" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={!canLeaveSkills} onClick={goAfterSkills} type="button">
                Continue
              </Button>
            </>
          }
          kicker="Skills"
          title="Choose skills"
        >
          <ImportSkillsScene
            onToggle={toggleSkill}
            onToggleAll={toggleSkills}
            resetKey={`${props.open}:${props.skills.length}`}
            selected={draftSkillSelection}
            skills={props.skills}
          />
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
          <ImportEntriesScene
            candidates={props.preview.candidates}
            onToggle={(name) => setDraftSelection((current) => toggleSelection(current, name))}
            selected={selected}
          />
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
          <ImportStrategyScene onChange={setConflictStrategy} strategy={conflictStrategy} />
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
          <ImportConflictsScene
            conflicts={conflicts}
            onToggleReplace={(key) =>
              setReplaceConflicts((current) => toggleSelection(current, key))
            }
            replaceConflicts={new Set(replaceConflicts)}
          />
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
                disabled={committing || !hasSelectedImport}
                onClick={() => void commit()}
                type="button"
              >
                <FileText />
                Commit import
              </Button>
            </>
          }
          kicker="Review"
          title="Review import"
          wide
        >
          <ImportReviewScene
            hostDisplayName={props.preview.host.displayName}
            preview={draftPreview}
            selectedSkills={selectedSkills}
          />
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
              Commit link
            </Button>
          </>
        }
        kicker="Review"
        title="Review config changes"
        wide
      >
        <LinkReviewScene preview={props.preview} />
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

function ChangeList(props: { changes: FileChange[]; defaultOpen?: boolean; title: string }) {
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

function UnifiedDiff(props: { change: FileChange }) {
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

function DiffStatBadge(props: { change: FileChange }) {
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

function diffStats(change: FileChange) {
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
