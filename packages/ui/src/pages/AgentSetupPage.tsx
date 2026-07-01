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
  SearchIcon,
  Sparkles,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import useMeasure from "react-use-measure";
import { type BackupManifest, type JsonRequestInit, type ServerEntry, useRatelApp } from "@/App";
import { SkillImportPicker, skillKey } from "@/components/import-skills-dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
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
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { DetailGrid, DetailLabel } from "@/components/ui/detail-grid";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { availableSkillsForKind, fetchSkills, type SkillSummary } from "@/lib/skills";
import { cn } from "@/lib/utils";

type AgentHostKind = "claude-code" | "codex";
type AgentScope = "user" | "project" | "local";
type AgentPosture = "unavailable" | "empty" | "not-linked" | "ratel-only" | "mixed";
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

interface DetectedAgentHostSummary {
  kind: AgentHostKind;
  displayName: string;
  detection: AgentHostDetection;
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

function agentHostsFromResponse(body: unknown): DetectedAgentHostSummary[] {
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

interface AgentPlanPreview {
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
    description: "Only Ratel gateway entries are configured.",
  },
  mixed: {
    label: "Mixed",
    tone: "default",
    description: "Native and Ratel entries are both present.",
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
function useAvailableSkills() {
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
  const { clearSetupIntent, config, openCommandMenu, refresh, request, setupIntent, token } =
    useRatelApp();
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
              <ButtonGroup>
                <Button
                  aria-label="Search"
                  onClick={openCommandMenu}
                  size="icon-lg"
                  type="button"
                  variant="outline"
                >
                  <SearchIcon />
                  <span className="sr-only">Search</span>
                </Button>
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
              </ButtonGroup>
              <PageHeaderSidebarTrigger />
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
                icon={<SearchIcon />}
                kbd="⌘K"
                label="Search"
                onClick={openCommandMenu}
              />
              <ResponsiveToolbarButton
                disabled={scanning}
                icon={<RefreshCw className={cn(scanning && "animate-spin")} />}
                kbd="⌘R"
                label="Refresh"
                onClick={() => void Promise.all([refresh(), scanHosts()])}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
        </PageHeaderActions>
      </PageHeader>

      <section className="grid gap-3">
        <div className="grid gap-3 xl:grid-cols-2">
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
  const { openCommandMenu, refresh, request, token } = useRatelApp();
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
              <ButtonGroup>
                <Button
                  aria-label="Search"
                  onClick={openCommandMenu}
                  size="icon-lg"
                  type="button"
                  variant="outline"
                >
                  <SearchIcon />
                  <span className="sr-only">Search</span>
                </Button>
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
              </ButtonGroup>
              <PageHeaderSidebarTrigger />
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
                icon={<SearchIcon />}
                kbd="⌘K"
                label="Search"
                onClick={openCommandMenu}
              />
              <ResponsiveToolbarButton
                disabled={scanning}
                icon={<RefreshCw className={cn(scanning && "animate-spin")} />}
                kbd="⌘R"
                label="Refresh"
                onClick={() => void Promise.all([refresh(), scanHosts()])}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
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
  return (
    <div className="group grid gap-3 border border-border bg-background p-4 transition-colors hover:border-brand-green/60 hover:bg-brand-green/5">
      <button
        className="flex w-full min-w-0 items-start gap-3 text-left"
        onClick={props.onOpen}
        type="button"
      >
        <AgentIcon kind={props.host.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <h4 className="min-w-0 truncate text-xl font-semibold tracking-tight">
              {props.host.displayName}
            </h4>
            <LinkStatusBadge host={props.host} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{posture.description}</p>
          {missingRatelEntryNames(props.host).length > 0 ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              {missingRatelEntryNames(props.host).length} native tool
              {missingRatelEntryNames(props.host).length === 1 ? "" : "s"} not in Ratel.
            </p>
          ) : null}
          {props.unmanagedSkillCount > 0 ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              {props.unmanagedSkillCount} skill{props.unmanagedSkillCount === 1 ? "" : "s"} not
              managed by Ratel.
            </p>
          ) : null}
          <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
            {primaryPath ?? props.host.detection.reasons[0] ?? "Known paths unavailable"}
          </p>
        </div>
      </button>
    </div>
  );
}

function AgentOperationPanel(props: {
  availableSkills: SkillSummary[];
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
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
          description="Choose native MCP entries and skills to bring under Ratel in one reviewed flow."
          icon={<Download />}
          title="Import into Ratel"
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
          description="Write the Ratel gateway entry into this agent config."
          icon={<LinkIcon />}
          title="Link Ratel gateway"
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
  const title = installed
    ? "Remove Ratel statusline"
    : otherConfigured
      ? "Replace configured statusline"
      : "Install Ratel statusline";
  const description = installed
    ? "Remove the Ratel-owned command from Claude Code user settings."
    : otherConfigured
      ? "Replace the existing Claude Code statusLine command with Ratel."
      : "Write the Ratel statusline command into Claude Code user settings.";

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
    <SetupActionSection
      description="Manage the Claude Code user-level statusLine setting."
      icon={<FileText />}
      title="Claude statusline"
    >
      <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <h4 className="font-medium">{title}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          {!props.state.ratelEnabled ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              Ratel MCP is not enabled in Claude Code.
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
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {props.icon}
          {props.title}
        </h3>
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
  const { runAction } = useRatelApp();
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

  const agentChanges = preview?.plan.agentChanges ?? [];
  const linkedAndCovered =
    props.host.ratelEntryCount > 0 && missingRatelEntryNames(props.host).length === 0;
  const friendlyNoOp = Boolean(
    preview?.emptyReason && linkedAndCovered && props.availableSkills.length === 0,
  );

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
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const applyAgent = async (
    activePreview: AgentPlanPreview,
    options?: {
      conflictStrategy?: ConflictStrategy;
      replaceConflicts?: string[];
    },
  ) => {
    const path =
      props.flow === "import" ? "/api/agent-apply/import/agent" : "/api/agent-apply/link";
    const applied = await runAction(
      props.flow === "import" ? "Agent config rewritten" : "Link complete",
      () =>
        props.request(path, {
          method: "POST",
          body: {
            hostKind: props.hostKind,
            selection: props.flow === "import" ? activePreview.selected : undefined,
            conflictStrategy: props.flow === "import" ? options?.conflictStrategy : undefined,
            replaceConflicts: props.flow === "import" ? options?.replaceConflicts : undefined,
            planHash: activePreview.stageHashes.agent,
          },
        }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const commitImport = async (
    importPreview: AgentPlanPreview,
    conflictStrategy: ConflictStrategy,
    replaceConflicts: string[],
    selectedSkills: SkillSummary[],
  ) => {
    if (importPreview.plan.ratelChanges.length > 0) {
      const ratelApplied = await applyRatel(importPreview, conflictStrategy, replaceConflicts);
      if (!ratelApplied) return false;
    }
    if (importPreview.plan.agentChanges.length > 0) {
      const agentApplied = await applyAgent(importPreview, {
        conflictStrategy,
        replaceConflicts,
      });
      if (!agentApplied) return false;
    }
    if (selectedSkills.length > 0) {
      const skillsApplied = await activateSelectedSkills(selectedSkills);
      if (!skillsApplied) return false;
    }
    setDialogOpen(false);
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
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const commitLink = async () => {
    if (!preview) return false;
    if (agentChanges.length > 0) {
      const linked = await applyAgent(preview);
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
    <section className="grid gap-3 border-border border-t pt-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
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
        <div className="py-6 text-sm text-muted-foreground">No backups yet.</div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {props.backups.map((backup, index) => (
            <BackupRow
              backup={backup}
              key={`${backup.createdAt}-${backup.action}`}
              latest={index === 0}
            />
          ))}
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
        "grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center",
        props.latest && "bg-muted/25",
      )}
    >
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="font-medium">{restoreActionLabel(props.backup.action)}</p>
          <span className="text-xs text-muted-foreground">
            {restoreCreatedLabel(props.backup.createdAt)}
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span className={cn(props.latest && "font-medium text-foreground")}>
            {props.latest ? "Latest backup" : "Previous backup"}
          </span>
          <span aria-hidden="true">/</span>
          <span>{backupFileSummary(props.backup.entries.length)}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{paths}</p>
      </div>
    </div>
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

function backupFileSummary(count: number) {
  return `${count} config file${count === 1 ? "" : "s"} backed up`;
}

function SetupRecap(props: {
  availableSkills: SkillSummary[];
  flow: SetupFlow;
  onOpen: () => void;
  preview: AgentPlanPreview;
}) {
  const changes = props.preview.plan.ratelChanges.length + props.preview.plan.agentChanges.length;
  const importableCount =
    props.preview.candidates.length + (props.flow === "import" ? props.availableSkills.length : 0);
  const actionLabel = props.flow === "import" ? "Import" : "Link";
  return (
    <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div>
        <h4 className="font-medium">
          {props.flow === "import" ? "Import into Ratel" : "Link Ratel gateway"}
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {props.flow === "import"
            ? "Choose MCP entries and skills, resolve conflicts if needed, then review changes."
            : "Review the exact agent config change before writing it."}
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

type ImportScene = "recap" | "strategy" | "pick-conflicts" | "review";

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
  const [scene, setScene] = useState<ImportScene>("recap");
  const [committing, setCommitting] = useState(false);
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
  const goAfterRecap = () =>
    setScene(draftSelection.length > 0 && conflicts.length > 0 ? "strategy" : "review");
  const goAfterStrategy = () =>
    setScene(conflictStrategy === "replace-selected" ? "pick-conflicts" : "review");

  useEffect(() => {
    if (!props.open) return;
    setDraftPreview(props.preview);
    setDraftSelection(props.preview.selected);
    setDraftSkillSelection(new Set());
    setConflictStrategy("add-missing-only");
    setReplaceConflicts([]);
  }, [props.open, props.preview]);

  useEffect(() => {
    if (!props.open) return;
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
    props.hostKind,
    props.open,
    props.request,
    replaceConflicts,
  ]);

  const commit = async () => {
    setCommitting(true);
    try {
      await props.onCommit(draftPreview, conflictStrategy, replaceConflicts, selectedSkills);
    } finally {
      setCommitting(false);
    }
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
        if (open) setScene("recap");
      }}
      scene={scene}
      title="Import"
    >
      {scene === "recap" ? (
        <ScenePanel
          flushFooter
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={!hasSelectedImport} onClick={goAfterRecap} type="button">
                Continue
              </Button>
            </>
          }
          kicker="Import"
          title="Choose what to import"
        >
          <div className="grid gap-3">
            {props.preview.candidates.length > 0 ? (
              <div className="grid gap-2">
                <h4 className="px-1 font-medium text-sm">
                  MCP entries{" "}
                  <span className="text-muted-foreground">({props.preview.candidates.length})</span>
                </h4>
                <SceneScrollSection className="max-h-60">
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
              </div>
            ) : null}
            {props.skills.length > 0 ? (
              <div className="grid gap-2">
                <h4 className="px-1 font-medium text-sm">
                  Skills <span className="text-muted-foreground">({props.skills.length})</span>
                </h4>
                <SkillImportPicker
                  className="[&_[data-skill-scroll]]:max-h-72"
                  onToggle={toggleSkill}
                  onToggleAll={toggleSkills}
                  resetKey={`${props.open}:${props.skills.length}`}
                  selected={draftSkillSelection}
                  skills={props.skills}
                />
              </div>
            ) : null}
          </div>
        </ScenePanel>
      ) : null}
      {scene === "strategy" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={() => setScene("recap")} type="button" variant="outline">
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
                onClick={() =>
                  setScene(
                    requiresConflictSelection
                      ? "pick-conflicts"
                      : conflicts.length > 0
                        ? "strategy"
                        : "recap",
                  )
                }
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
          title="Review config changes"
          wide
        >
          <SceneScrollSection className="grid max-h-[65vh] gap-4">
            <ChangeList changes={draftPreview.plan.ratelChanges} defaultOpen title="Ratel config" />
            <ChangeList
              changes={draftPreview.plan.agentChanges}
              defaultOpen
              title={`${props.preview.host.displayName} config`}
            />
            <SkillActivationReview skills={selectedSkills} />
          </SceneScrollSection>
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
        <SceneScrollSection className="max-h-[65vh]">
          <ChangeList
            changes={props.preview.plan.agentChanges}
            defaultOpen
            title={`${props.preview.host.displayName} changes`}
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

function LinkStatusBadge(props: { host: DetectedAgentHostSummary }) {
  if (props.host.posture === "unavailable") {
    return <StatusBadge tone="muted">Unavailable</StatusBadge>;
  }
  if (props.host.ratelEntryCount > 0) {
    return <StatusBadge tone="success">Linked</StatusBadge>;
  }
  return <StatusBadge tone="muted">Not linked</StatusBadge>;
}

function ClaudeStatuslineBadge(props: { state: ClaudeStatuslineState }) {
  if (props.state.status === "installed") {
    return <StatusBadge tone="success">Installed</StatusBadge>;
  }
  if (props.state.status === "other") {
    return <StatusBadge tone="warning">Other configured</StatusBadge>;
  }
  return <StatusBadge tone="muted">Not installed</StatusBadge>;
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
