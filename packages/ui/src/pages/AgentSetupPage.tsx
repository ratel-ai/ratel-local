import { useNavigate } from "@tanstack/react-router";
import { type StructuredPatchHunk, structuredPatch } from "diff";
import {
  ArrowLeft,
  Download,
  FileText,
  GitCompare,
  LinkIcon,
  RefreshCw,
  SearchIcon,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import useMeasure from "react-use-measure";
import { type BackupManifest, type JsonRequestInit, type ServerEntry, useRatelApp } from "@/App";
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

export function AgentSetupPage() {
  const { clearSetupIntent, config, openCommandMenu, refresh, request, setupIntent, token } =
    useRatelApp();
  const navigate = useNavigate();
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
            <AgentDirectoryCard host={host} key={host.kind} onOpen={() => openAgent(host.kind)} />
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
            {missingRatelEntryNames(host).length > 0 ? (
              <>
                <DetailLabel>Coverage</DetailLabel>
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  {missingRatelEntryNames(host).length} native tool
                  {missingRatelEntryNames(host).length === 1 ? "" : "s"} not in Ratel.
                </p>
              </>
            ) : null}
            <DetailLabel>Config</DetailLabel>
            <code className="min-w-0 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {primaryPath ?? "Known paths unavailable"}
            </code>
          </DetailGrid>

          <AgentOperationPanel
            host={host}
            hostKind={host.kind}
            onScanHosts={scanHosts}
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

function AgentDirectoryCard(props: { host: DetectedAgentHostSummary; onOpen: () => void }) {
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
          <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
            {primaryPath ?? props.host.detection.reasons[0] ?? "Known paths unavailable"}
          </p>
        </div>
      </button>
    </div>
  );
}

function AgentOperationPanel(props: {
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const canImport = missingRatelEntryNames(props.host).length > 0;
  const canLink = props.host.posture !== "unavailable" && props.host.ratelEntryCount === 0;
  return (
    <section className="-mx-4 grid gap-5 border-border border-y bg-muted/10 px-4 py-5 sm:-mx-6 sm:px-6">
      {canImport ? (
        <SetupActionSection
          description="Copy native MCP entries into Ratel. After review, selected entries are removed from the agent config."
          icon={<Download />}
          title="Import native entries"
        >
          <PreviewFlow
            flow="import"
            host={props.host}
            hostKind={props.hostKind}
            key={`import:${props.hostKind}`}
            onScanHosts={props.onScanHosts}
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
            flow="link"
            host={props.host}
            hostKind={props.hostKind}
            key={`link:${props.hostKind}`}
            onScanHosts={props.onScanHosts}
            request={props.request}
          />
        </SetupActionSection>
      ) : null}
      {!canImport && !canLink ? (
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Nothing to do</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            This agent is linked, and all native entries are already in Ratel.
          </p>
        </div>
      ) : null}
    </section>
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
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onScanHosts: () => Promise<void>;
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
  const friendlyNoOp = Boolean(preview?.emptyReason && linkedAndCovered);

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
    setDialogOpen(false);
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
            <SetupRecap flow={props.flow} onOpen={() => setDialogOpen(true)} preview={preview} />
          )}
          {preview.emptyReason && !friendlyNoOp ? (
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

function SetupRecap(props: { flow: SetupFlow; onOpen: () => void; preview: AgentPlanPreview }) {
  const changes = props.preview.plan.ratelChanges.length + props.preview.plan.agentChanges.length;
  const actionLabel = props.flow === "import" ? "Import" : "Link";
  return (
    <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div>
        <h4 className="font-medium">
          {props.flow === "import" ? "Import native entries" : "Link Ratel gateway"}
        </h4>
        <p className="mt-1 text-sm text-muted-foreground">
          {props.flow === "import"
            ? "Choose entries, resolve conflicts if needed, then review the exact config changes."
            : "Review the exact agent config change before writing it."}
        </p>
      </div>
      <Button
        className="min-h-12 px-6 text-base md:min-w-40"
        disabled={changes === 0}
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
  ) => Promise<boolean>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  preview: AgentPlanPreview;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const [scene, setScene] = useState<ImportScene>("recap");
  const [committing, setCommitting] = useState(false);
  const [draftPreview, setDraftPreview] = useState<AgentPlanPreview>(props.preview);
  const [draftSelection, setDraftSelection] = useState<string[]>(props.preview.selected);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>("add-missing-only");
  const [replaceConflicts, setReplaceConflicts] = useState<string[]>([]);
  const selected = new Set(draftSelection);
  const conflicts = draftPreview.plan.summary.conflicts;
  const requiresConflictSelection = conflicts.length > 0 && conflictStrategy === "replace-selected";
  const goAfterRecap = () => setScene(conflicts.length > 0 ? "strategy" : "review");
  const goAfterStrategy = () =>
    setScene(conflictStrategy === "replace-selected" ? "pick-conflicts" : "review");

  useEffect(() => {
    if (!props.open) return;
    setDraftPreview(props.preview);
    setDraftSelection(props.preview.selected);
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
      await props.onCommit(draftPreview, conflictStrategy, replaceConflicts);
    } finally {
      setCommitting(false);
    }
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
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button onClick={goAfterRecap} type="button">
                Continue
              </Button>
            </>
          }
          kicker="Entries"
          title="Choose entries to import"
        >
          <div className="grid gap-3">
            <div className="max-h-60 overflow-auto border border-border">
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
            </div>
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
          <p className="text-sm text-muted-foreground">
            Selected entries will overwrite the matching Ratel entry. Unselected entries keep the
            current Ratel version.
          </p>
          <ConflictPickList
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
              <Button disabled={committing} onClick={() => void commit()} type="button">
                <FileText />
                Commit import
              </Button>
            </>
          }
          kicker="Review"
          title="Review config changes"
          wide
        >
          <div className="grid max-h-[65vh] gap-4 overflow-auto pr-1">
            <ChangeList changes={draftPreview.plan.ratelChanges} defaultOpen title="Ratel config" />
            <ChangeList
              changes={draftPreview.plan.agentChanges}
              defaultOpen
              title={`${props.preview.host.displayName} config`}
            />
          </div>
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
        <div className="max-h-[65vh] overflow-auto pr-1">
          <ChangeList
            changes={props.preview.plan.agentChanges}
            defaultOpen
            title={`${props.preview.host.displayName} changes`}
          />
        </div>
      </ScenePanel>
    </SceneDialog>
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
            className="relative w-full max-w-4xl overflow-hidden border border-border bg-background shadow-2xl"
            initial={{ y: 24, scale: 0.985 }}
            exit={{ y: 24, scale: 0.985 }}
          >
            <div ref={measureRef}>
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
                  {props.children}
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
  footer: React.ReactNode;
  kicker: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <div className={cn("grid gap-5 p-4", props.wide ? "sm:p-5" : "sm:p-5")}>
      <div>
        <DetailLabel>{props.kicker}</DetailLabel>
        <h3 className="mt-1 text-xl font-semibold tracking-tight">{props.title}</h3>
      </div>
      {props.children}
      <div className="flex flex-wrap justify-end gap-2 border-border border-t pt-4">
        {props.footer}
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
    <div className="grid max-h-80 gap-2 overflow-auto pr-1">
      {props.conflicts.map((conflict) => {
        const key = `${conflict.scope}:${conflict.name}`;
        const selected = props.replaceConflicts.has(key);
        return (
          <button
            className={cn(
              "grid gap-1 border px-3 py-2 text-left",
              selected ? "border-brand-green bg-brand-green/10" : "border-border bg-background",
            )}
            key={key}
            onClick={() => props.onToggleReplace(key)}
            type="button"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{conflict.name}</span>
              <Badge variant="outline">{conflict.scope}</Badge>
            </div>
            <span className="text-xs text-muted-foreground">
              Ratel: {summarizeEntry(conflict.existing)}
            </span>
            <span className="text-xs text-muted-foreground">
              Agent: {summarizeEntry(conflict.incoming)}
            </span>
          </button>
        );
      })}
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
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
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
          className="border border-border bg-background"
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
    <div className="max-h-[32rem] overflow-auto border-border border-t bg-muted/20">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {rows.map((row) =>
            row.kind === "hunk" ? (
              <tr className="bg-brand-green/10 text-brand-green" key={diffRowKey(row)}>
                <td className="w-12 select-none px-2 py-1 text-right text-brand-green/70">...</td>
                <td className="w-12 select-none border-border border-r px-2 py-1 text-right text-brand-green/70">
                  ...
                </td>
                <td className="px-2 py-1">{row.content}</td>
              </tr>
            ) : (
              <tr className={diffRowClassName(row.kind)} key={diffRowKey(row)}>
                <td className="w-12 select-none px-2 py-0.5 text-right text-muted-foreground">
                  {row.oldLine ?? ""}
                </td>
                <td className="w-12 select-none border-border border-r px-2 py-0.5 text-right text-muted-foreground">
                  {row.newLine ?? ""}
                </td>
                <td className="px-2 py-0.5 whitespace-pre-wrap break-words">
                  <span className="mr-2 select-none text-muted-foreground">
                    {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
                  </span>
                  {row.content.length > 0 ? row.content : " "}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
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

function StatusBadge(props: { children: React.ReactNode; tone: "muted" | "success" }) {
  return (
    <Badge
      className={cn(
        "gap-1.5 rounded-full px-2 font-medium",
        props.tone === "success"
          ? "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
          : "border-border bg-muted text-muted-foreground",
      )}
      variant="outline"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          props.tone === "success" ? "bg-emerald-500" : "bg-muted-foreground/50",
        )}
      />
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
