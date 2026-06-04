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
  Undo2,
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
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

export function AgentSetupPage() {
  const {
    clearSetupIntent,
    config,
    openCommandMenu,
    refresh,
    request,
    runAction,
    setupIntent,
    token,
  } = useRatelApp();
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<DetectedAgentHostSummary[]>([]);
  const [scanning, setScanning] = useState(false);
  const handledIntent = useRef<number | null>(null);
  const backups = config?.backups ?? [];

  const scanHosts = useCallback(async () => {
    setScanning(true);
    try {
      const body = await request<AgentHostsResponse>("/api/agent-hosts");
      setHosts(body.hosts);
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
          <PageHeaderDescription>
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

      <RestorePoints backups={backups} request={request} runAction={runAction} />
    </main>
  );
}

export function AgentDetailPage(props: { kind: AgentHostKind; operation?: SetupFlow }) {
  const { openCommandMenu, refresh, request, token } = useRatelApp();
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<DetectedAgentHostSummary[]>([]);
  const [scanning, setScanning] = useState(false);
  const [operation, setOperation] = useState<SetupFlow>(props.operation ?? "import");

  const scanHosts = useCallback(async () => {
    setScanning(true);
    try {
      const body = await request<AgentHostsResponse>("/api/agent-hosts");
      setHosts(body.hosts);
    } finally {
      setScanning(false);
    }
  }, [request]);

  useEffect(() => {
    void scanHosts();
  }, [scanHosts]);

  useEffect(() => {
    if (props.operation) setOperation(props.operation);
  }, [props.operation]);

  const host = hosts.find((item) => item.kind === props.kind);
  const goBack = () => {
    const target = token ? `/agent-setup?t=${encodeURIComponent(token)}` : "/agent-setup";
    void navigate({ to: target } as never);
  };
  const switchHost = (kind: AgentHostKind) => {
    const search = new URLSearchParams();
    if (token) search.set("t", token);
    search.set("operation", operation);
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
        <section className="-mx-4 grid gap-2 border-border border-y bg-muted/10 px-4 py-2 sm:hidden">
          <AgentPageSwitcher
            className="w-full"
            currentKind={host.kind}
            hosts={hosts}
            onHostKindChange={switchHost}
          />
        </section>
      ) : null}

      {host ? (
        <section className="grid gap-5">
          <div className="-mx-4 grid gap-3 border-border border-y bg-muted/15 px-4 py-4 sm:-mx-6 sm:px-6 md:grid-cols-[10rem_minmax(0,1fr)]">
            <span className="text-xs font-medium text-muted-foreground uppercase">Host</span>
            <div className="flex min-w-0 items-center gap-2">
              <AgentIcon kind={host.kind} />
              <span className="font-medium">{host.displayName}</span>
            </div>
            <span className="text-xs font-medium text-muted-foreground uppercase">Status</span>
            <LinkStatusBadge host={host} />
            <span className="text-xs font-medium text-muted-foreground uppercase">Config</span>
            <code className="min-w-0 truncate rounded-md bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {primaryPath ?? "Known paths unavailable"}
            </code>
          </div>

          <AgentCoverageNotice host={host} />
          <AgentScopePanel host={host} />
          <AgentOperationPanel
            flow={operation}
            host={host}
            hostKind={host.kind}
            onFlowChange={setOperation}
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

function AgentCoverageNotice(props: { host: DetectedAgentHostSummary }) {
  const missing = missingRatelEntryNames(props.host);
  if (missing.length === 0) return null;
  return (
    <Alert>
      <AlertTitle>Native tools are not in Ratel</AlertTitle>
      <AlertDescription>
        {missing.join(", ")} exist in {props.host.displayName} but are not present in the Ratel
        config yet.
      </AlertDescription>
    </Alert>
  );
}

function AgentScopePanel(props: { host: DetectedAgentHostSummary }) {
  return (
    <section className="-mx-4 overflow-hidden border-border border-y sm:-mx-6">
      <div className="border-border border-b bg-muted/35 px-4 py-2 sm:px-6">
        <h3 className="font-medium">Config scopes</h3>
      </div>
      <div className="divide-y divide-border">
        {props.host.scopes.map((scope) => (
          <div
            className="grid gap-2 px-4 py-3 sm:px-6 lg:grid-cols-[10rem_minmax(0,1fr)_auto] lg:items-center"
            key={scope.scope}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium capitalize">{scope.scope}</span>
              <ScopeLinkStatusBadge scope={scope} />
            </div>
            <p className="truncate font-mono text-xs text-muted-foreground">{scope.path}</p>
            <div className="flex flex-wrap gap-1 lg:justify-end">
              <Badge variant="outline">{scope.nativeEntryCount} native</Badge>
              <Badge variant="outline">{scope.ratelEntryCount} Ratel</Badge>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function AgentOperationPanel(props: {
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  hostKind: AgentHostKind;
  onFlowChange: (flow: SetupFlow) => void;
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const description =
    props.flow === "import"
      ? "Move native entries into Ratel, then clean the agent config."
      : "Write the Ratel gateway. Native entries stay where they are.";
  return (
    <section className="-mx-4 grid gap-3 border-border border-y bg-muted/10 px-4 py-5 sm:-mx-6 sm:px-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-lg font-semibold tracking-tight">Setup flow</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <Tabs
          className="w-fit"
          onValueChange={(value) => props.onFlowChange(value as SetupFlow)}
          value={props.flow}
        >
          <TabsList>
            <TabsTrigger value="import">
              <Download />
              Import
            </TabsTrigger>
            <TabsTrigger value="link">
              <LinkIcon />
              Link
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <PreviewFlow
        flow={props.flow}
        host={props.host}
        hostKind={props.hostKind}
        key={`${props.flow}:${props.hostKind}`}
        onScanHosts={props.onScanHosts}
        request={props.request}
      />
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
  const [selection, setSelection] = useState<string[] | null>(null);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>("add-missing-only");
  const [replaceConflicts, setReplaceConflicts] = useState<string[]>([]);
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
            selection: props.flow === "import" ? (selection ?? undefined) : undefined,
            conflictStrategy: props.flow === "import" ? conflictStrategy : undefined,
            replaceConflicts: props.flow === "import" ? replaceConflicts : undefined,
          },
        });
        if (cancelled) return;
        setPreview(body);
        if (props.flow === "import") setSelection((current) => current ?? body.selected);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    conflictStrategy,
    previewPath,
    props.flow,
    props.hostKind,
    props.request,
    replaceConflicts,
    selection,
  ]);

  const ratelChanges = preview?.plan.ratelChanges ?? [];
  const agentChanges = preview?.plan.agentChanges ?? [];
  const selectedSet = new Set(selection ?? preview?.selected ?? []);
  const linkedAndCovered =
    props.host.ratelEntryCount > 0 && missingRatelEntryNames(props.host).length === 0;
  const friendlyNoOp = Boolean(preview?.emptyReason && linkedAndCovered);

  const applyRatel = async () => {
    if (!preview) return false;
    const applied = await runAction("Ratel config changes applied", () =>
      props.request("/api/agent-apply/import/ratel", {
        method: "POST",
        body: {
          hostKind: props.hostKind,
          selection: preview.selected,
          conflictStrategy,
          replaceConflicts,
          planHash: preview.stageHashes.ratel,
        },
      }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const applyAgent = async () => {
    if (!preview) return false;
    const path =
      props.flow === "import" ? "/api/agent-apply/import/agent" : "/api/agent-apply/link";
    const applied = await runAction(
      props.flow === "import" ? "Agent config rewritten" : "Link complete",
      () =>
        props.request(path, {
          method: "POST",
          body: {
            hostKind: props.hostKind,
            selection: props.flow === "import" ? preview.selected : undefined,
            conflictStrategy: props.flow === "import" ? conflictStrategy : undefined,
            replaceConflicts: props.flow === "import" ? replaceConflicts : undefined,
            planHash: preview.stageHashes.agent,
          },
        }),
    );
    if (!applied) return false;
    await props.onScanHosts();
    setRefreshNonce((value) => value + 1);
    return true;
  };

  const commitImport = async () => {
    if (!preview) return false;
    if (ratelChanges.length > 0) {
      const ratelApplied = await applyRatel();
      if (!ratelApplied) return false;
    }
    if (agentChanges.length > 0) {
      const agentApplied = await applyAgent();
      if (!agentApplied) return false;
    }
    setDialogOpen(false);
    return true;
  };

  const commitLink = async () => {
    if (!preview) return false;
    if (agentChanges.length > 0) {
      const linked = await applyAgent();
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
              flow={props.flow}
              host={props.host}
              onOpen={() => setDialogOpen(true)}
              preview={preview}
            />
          )}
          {props.flow === "link" && missingRatelEntryNames(props.host).length > 0 ? (
            <LinkKeepsNativeEntriesNotice host={props.host} />
          ) : null}
          {preview.emptyReason && !friendlyNoOp ? (
            <Alert>
              <AlertTitle>No changes available</AlertTitle>
              <AlertDescription>{preview.emptyReason}</AlertDescription>
            </Alert>
          ) : null}
          {!friendlyNoOp && props.flow === "import" ? (
            <ImportSceneDialog
              conflictStrategy={conflictStrategy}
              onCommit={commitImport}
              onConflictStrategyChange={setConflictStrategy}
              onOpenChange={setDialogOpen}
              onToggleReplace={(key) =>
                setReplaceConflicts((current) => toggleSelection(current, key))
              }
              open={dialogOpen}
              preview={preview}
              replaceConflicts={new Set(replaceConflicts)}
              selected={selectedSet}
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

function RestorePoints(props: {
  backups: BackupManifest[];
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  runAction: (
    label: string,
    action: () => Promise<{ log?: string[] } | unknown>,
  ) => Promise<boolean>;
}) {
  const [restoreBackup, setRestoreBackup] = useState<BackupManifest | null>(null);
  const restoreLatest = async () => {
    const restored = await props.runAction("Restore complete", () =>
      props.request("/api/backups/undo", { method: "POST", body: {} }),
    );
    if (restored) setRestoreBackup(null);
  };

  return (
    <section className="grid gap-3 border-border border-t pt-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-medium">Restore Points</h3>
          <p className="text-sm text-muted-foreground">
            Recent changes created by import, link, and other config writes.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {props.backups.length} restore point{props.backups.length === 1 ? "" : "s"}
        </p>
      </div>
      {props.backups.length === 0 ? (
        <div className="py-6 text-sm text-muted-foreground">No restore points yet.</div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {props.backups.map((backup, index) => (
            <RestorePointRow
              backup={backup}
              key={`${backup.createdAt}-${backup.action}`}
              latest={index === 0}
              onRestore={() => setRestoreBackup(backup)}
            />
          ))}
        </div>
      )}
      <AlertDialog
        open={restoreBackup !== null}
        onOpenChange={(open) => !open && setRestoreBackup(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Undo2 />
            </AlertDialogMedia>
            <AlertDialogTitle>Restore latest point</AlertDialogTitle>
            <AlertDialogDescription>
              Restore the latest config backup created by{" "}
              {restoreBackup?.action ?? "the last write"}. The current config files will be replaced
              with the saved versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restoreBackup ? (
            <div className="rounded-md bg-muted/60 p-3">
              <p className="text-sm font-medium">{restoreBackup.action}</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {restoreBackup.entries.map((entry) => entry.originalPath).join(", ")}
              </p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void restoreLatest()} variant="destructive">
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RestorePointRow(props: {
  backup: BackupManifest;
  latest: boolean;
  onRestore: () => void;
}) {
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
            {props.latest ? "Latest restore point" : "Previous restore point"}
          </span>
          <span aria-hidden="true">/</span>
          <span>{restoreFileSummary(props.backup.entries.length)}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">{paths}</p>
      </div>
      {props.latest ? (
        <Button onClick={props.onRestore} size="sm" variant="outline">
          <Undo2 />
          Restore latest
        </Button>
      ) : (
        <span className="text-sm text-muted-foreground md:text-right">Only latest can restore</span>
      )}
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

function restoreFileSummary(count: number) {
  return `${count} config file${count === 1 ? "" : "s"} backed up`;
}

function SetupRecap(props: {
  flow: SetupFlow;
  host: DetectedAgentHostSummary;
  onOpen: () => void;
  preview: AgentPlanPreview;
}) {
  const summary = props.preview.plan.summary;
  const changes = props.preview.plan.ratelChanges.length + props.preview.plan.agentChanges.length;
  const actionLabel = props.flow === "import" ? "Import" : "Link";
  return (
    <div className="grid gap-4 border border-border bg-background p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-2">
          <StatusBadge tone={props.flow === "import" ? "success" : "muted"}>
            {props.flow === "import"
              ? `${props.preview.selected.length} sources`
              : `${props.host.ratelEntryCount} Ratel entries`}
          </StatusBadge>
          <StatusBadge tone={changes > 0 ? "success" : "muted"}>
            {changes} file change{changes === 1 ? "" : "s"}
          </StatusBadge>
          {props.flow === "import" ? (
            <StatusBadge tone={summary.conflicts.length > 0 ? "muted" : "success"}>
              {summary.conflicts.length} conflicts
            </StatusBadge>
          ) : null}
        </div>
        <div>
          <h4 className="font-medium">
            {props.flow === "import" ? "Ready to import native sources" : "Ready to link gateway"}
          </h4>
          <p className="mt-1 text-sm text-muted-foreground">
            {props.flow === "import"
              ? "Review the import, resolve conflicts, inspect the diff, then commit."
              : "Review the agent config diff, then write the gateway."}
          </p>
        </div>
        {props.flow === "import" && summary.skipped.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {summary.skipped.length} source{summary.skipped.length === 1 ? "" : "s"} skipped.
          </p>
        ) : null}
      </div>
      <Button disabled={changes === 0} onClick={props.onOpen}>
        {props.flow === "import" ? <Download /> : <LinkIcon />}
        {actionLabel}
      </Button>
    </div>
  );
}

type ImportScene = "recap" | "strategy" | "pick-conflicts" | "review";

function ImportSceneDialog(props: {
  conflictStrategy: ConflictStrategy;
  onCommit: () => Promise<boolean>;
  onConflictStrategyChange: (strategy: ConflictStrategy) => void;
  onOpenChange: (open: boolean) => void;
  onToggleReplace: (key: string) => void;
  open: boolean;
  preview: AgentPlanPreview;
  replaceConflicts: Set<string>;
  selected: Set<string>;
}) {
  const [scene, setScene] = useState<ImportScene>("recap");
  const [committing, setCommitting] = useState(false);
  const conflicts = props.preview.plan.summary.conflicts;
  const requiresConflictSelection =
    conflicts.length > 0 && props.conflictStrategy === "replace-selected";
  const goAfterRecap = () => setScene(conflicts.length > 0 ? "strategy" : "review");
  const goAfterStrategy = () =>
    setScene(props.conflictStrategy === "replace-selected" ? "pick-conflicts" : "review");
  const commit = async () => {
    setCommitting(true);
    try {
      await props.onCommit();
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
          kicker="Recap"
          title="Native sources found"
        >
          <div className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <SceneMetric label="Selected" value={props.selected.size} />
              <SceneMetric label="Conflicts" value={conflicts.length} />
              <SceneMetric
                label="Files"
                value={
                  props.preview.plan.ratelChanges.length + props.preview.plan.agentChanges.length
                }
              />
            </div>
            <div className="max-h-60 overflow-auto border border-border">
              {props.preview.candidates.map((candidate) => (
                <div
                  className="grid gap-1 border-border border-b px-3 py-2 last:border-b-0"
                  key={`${candidate.scope}:${candidate.name}`}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate font-medium">{candidate.name}</span>
                    <Badge variant="outline">{candidate.scope}</Badge>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {summarizeEntry(candidate.entry)}
                  </span>
                </div>
              ))}
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
          title="Choose what wins"
        >
          <div className="grid gap-2">
            <ConflictStrategyButton
              active={props.conflictStrategy === "add-missing-only"}
              detail="Keep existing Ratel entries and import only missing names."
              label="Keep Ratel"
              onClick={() => props.onConflictStrategyChange("add-missing-only")}
            />
            <ConflictStrategyButton
              active={props.conflictStrategy === "replace-from-agent"}
              detail="Replace every conflicting Ratel entry with the agent version."
              label="Replace all"
              onClick={() => props.onConflictStrategyChange("replace-from-agent")}
            />
            <ConflictStrategyButton
              active={props.conflictStrategy === "replace-selected"}
              detail="Pick conflict names one by one."
              label="Choose entries"
              onClick={() => props.onConflictStrategyChange("replace-selected")}
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
          kicker="Selection"
          title="Pick replacements"
        >
          <ConflictPickList
            conflicts={conflicts}
            onToggleReplace={props.onToggleReplace}
            replaceConflicts={props.replaceConflicts}
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
          title="Diff before write"
          wide
        >
          <div className="grid max-h-[65vh] gap-4 overflow-auto pr-1">
            <ChangeList
              changes={props.preview.plan.ratelChanges}
              defaultOpen
              title="Ratel changes"
            />
            <ChangeList
              changes={props.preview.plan.agentChanges}
              defaultOpen
              title={`${props.preview.host.displayName} cleanup`}
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
  const [scene, setScene] = useState<"recap" | "review">("recap");
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
    <SceneDialog
      open={props.open}
      onOpenChange={(open) => {
        props.onOpenChange(open);
        if (open) setScene("recap");
      }}
      scene={scene}
      title="Link"
    >
      {scene === "recap" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={() => props.onOpenChange(false)} type="button" variant="outline">
                Cancel
              </Button>
              <Button onClick={() => setScene("review")} type="button">
                Review diff
              </Button>
            </>
          }
          kicker="Recap"
          title="Gateway write"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <SceneMetric label="Agent files" value={props.preview.plan.agentChanges.length} />
            <SceneMetric label="Ratel entries" value={props.preview.host.ratelEntryCount} />
          </div>
        </ScenePanel>
      ) : null}
      {scene === "review" ? (
        <ScenePanel
          footer={
            <>
              <Button onClick={() => setScene("recap")} type="button" variant="outline">
                Back
              </Button>
              <Button disabled={committing} onClick={() => void commit()} type="button">
                <LinkIcon />
                Commit link
              </Button>
            </>
          }
          kicker="Review"
          title="Diff before write"
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
      ) : null}
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
        <p className="text-xs font-medium text-muted-foreground uppercase">{props.kicker}</p>
        <h3 className="mt-1 text-xl font-semibold tracking-tight">{props.title}</h3>
      </div>
      {props.children}
      <div className="flex flex-wrap justify-end gap-2 border-border border-t pt-4">
        {props.footer}
      </div>
    </div>
  );
}

function SceneMetric(props: { label: string; value: number }) {
  return (
    <div className="border border-border bg-muted/20 px-3 py-3">
      <p className="text-2xl font-semibold leading-none">{props.value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{props.label}</p>
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

function LinkKeepsNativeEntriesNotice(props: { host: DetectedAgentHostSummary }) {
  const missing = missingRatelEntryNames(props.host);
  return (
    <div className="flex flex-wrap items-center gap-2 border border-border bg-muted/20 px-3 py-2">
      <StatusBadge tone="muted">Native entries remain</StatusBadge>
      <span className="text-sm text-muted-foreground">
        {missing.length} native source{missing.length === 1 ? "" : "s"} stay in{" "}
        {props.host.displayName}. Import moves them into Ratel.
      </span>
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

function ScopeLinkStatusBadge(props: { scope: AgentScopePosture }) {
  if (!props.scope.available) return <StatusBadge tone="muted">Unavailable</StatusBadge>;
  if (props.scope.ratelEntryCount > 0) return <StatusBadge tone="success">Linked</StatusBadge>;
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
    <svg
      aria-hidden="true"
      className={cn("size-2/3", props.className)}
      fill="none"
      viewBox="0 0 600 600"
    >
      <title>Claude Code</title>
      <path
        clipRule="evenodd"
        d="M525 273.7h75v77.6h-75V427h-37.2v73H450v-73h-37.2v73H375v-73H225v73h-37.8v-73H150v73h-37.8v-73H75v-75.7H0v-77.6h75V125h450zm-375 0h37.2v-71.1H150zm262.8 0H450v-71.1h-37.2z"
        fill="#D97757"
        fillRule="evenodd"
      />
    </svg>
  );
}

function CodexMark(props: { className?: string } = {}) {
  return (
    <svg
      aria-hidden="true"
      className={cn("size-2/3 text-foreground", props.className)}
      fill="currentColor"
      fillRule="evenodd"
      viewBox="0 0 24 24"
    >
      <title>Codex (OpenAI)</title>
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
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
