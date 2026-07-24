import { useHotkey } from "@tanstack/react-hotkeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Download,
  FolderOpen,
  House,
  LayoutGrid,
  LinkIcon,
  Plus,
  RadioTower,
  Search,
  Server,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  UserCircle,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { BrandLogo } from "@/components/brand-logo";
import { ContextSwitcher } from "@/components/context-switcher";
import { ShortcutHint } from "@/components/shortcut-hint";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";
import {
  COMMAND_MENU_SHORTCUT,
  type PrimaryDestination,
  REFRESH_SHORTCUT,
} from "@/lib/keyboard-shortcuts";
import { type ProjectView, projectsFromResponse } from "@/lib/projects";
import { type JsonRequestInit, requestRatelApi } from "@/lib/ratel-api";
import { ratelApiQueryOptions, ratelQueryKeys } from "@/lib/ratel-query";
import {
  contextPagePath,
  legacyGlobalPath,
  pageSuffixFromPathname,
  type RuntimeUiContext,
  runtimeContextFromPathname,
  safeRememberedRoute,
} from "@/lib/runtime-context";
import { cn } from "@/lib/utils";
import "./App.css";

export type RatelScope = "user" | "project" | "local";
export type AuthStatus = "n/a" | "needs auth" | "expired" | "ok" | "unsupported";
type AgentHostKind = "claude-code" | "codex";
type AgentPosture = "unavailable" | "empty" | "not-linked" | "ratel-only" | "mixed";
type RatelConnectionKind = "none" | "explicit" | "plugin" | "duplicate";

export interface ServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  scope?: string;
  [key: string]: unknown;
}

export interface RatelConfig {
  mcpServers: Record<string, ServerEntry>;
  retrieval?: RetrievalConfig;
}

export type RetrievalConfig = {
  method: "bm25" | "semantic" | "hybrid";
  embedding?:
    | string
    | {
        huggingface: string;
        revision?: string;
        queryPrefix?: string;
        docPrefix?: string;
        pooling?: "cls" | "mean";
        download?: boolean;
      }
    | {
        local: string;
        queryPrefix?: string;
        docPrefix?: string;
        pooling?: "cls" | "mean";
      }
    | {
        ollama: string;
        queryPrefix?: string;
        docPrefix?: string;
      }
    | {
        url: string;
        model: string;
        apiKeyEnv?: string;
        queryPrefix?: string;
        docPrefix?: string;
      };
};

export interface BackupManifest {
  createdAt: string;
  action: "import" | "add" | "remove" | "edit" | "link";
  entries: Array<{ originalPath: string; backupPath: string; existedBefore: boolean }>;
}

export type ScopeState =
  | {
      available: true;
      path: string;
      config: RatelConfig;
      authStatus: Record<string, AuthStatus>;
    }
  | { available: false };

export interface ConfigResponse {
  homeDir: string;
  projectRoot: string | null;
  scopes: Record<RatelScope, ScopeState>;
  backups: BackupManifest[];
  toolTokenEstimatesByServer: Record<string, ServerToolTokenEstimate>;
  documents?: Array<{
    ref: { scope: RatelScope; projectId?: string };
    documentRevision: string;
    path: string;
  }>;
  runtimeRevision?: string;
  effectiveRetrieval?: RetrievalConfig;
}

export interface ServerToolTokenEstimate {
  server: string;
  toolCount: number;
  estimatedTokens: number;
  lastSeen: string | null;
}

interface AgentHostDetection {
  displayName: string;
  present: boolean;
  reasons: string[];
  warnings: string[];
}

interface AgentScopePosture {
  scope: RatelScope;
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

interface DetectedAgentHostSummary {
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

export type { JsonRequestInit } from "@/lib/ratel-api";

type SetupIntent = { id: number; kind: "import" | "link" };

interface RatelAppContextValue {
  config: ConfigResponse | null;
  configError: string | null;
  configLoading: boolean;
  context: RuntimeUiContext;
  pagePath: (page: string) => string;
  projects: ProjectView[];
  projectsError: string | null;
  projectsLoading: boolean;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  refresh: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  setupIntent: SetupIntent | null;
  token: string;
  clearSetupIntent: () => void;
  triggerSetupIntent: (kind: SetupIntent["kind"]) => void;
}

const RatelAppContext = createContext<RatelAppContextValue | null>(null);

export const SCOPES: RatelScope[] = ["user", "project", "local"];
const LAST_ROUTE_STORAGE_KEY = "ratel:last-route:v1";

export function AppShell() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const token = tokenFromSearch(location.searchStr);
  const parsedRuntimeContext = runtimeContextFromPathname(location.pathname);
  const runtimeContextKind = parsedRuntimeContext.kind;
  const runtimeProjectId =
    parsedRuntimeContext.kind === "project" ? parsedRuntimeContext.projectId : null;
  const runtimeContext = useMemo<RuntimeUiContext>(
    () =>
      runtimeContextKind === "project"
        ? { kind: "project", projectId: runtimeProjectId ?? "" }
        : { kind: runtimeContextKind },
    [runtimeContextKind, runtimeProjectId],
  );
  const [commandOpen, setCommandOpen] = useState(false);
  const [setupIntent, setSetupIntent] = useState<SetupIntent | null>(null);

  const request = useCallback(
    <T,>(path: string, init: JsonRequestInit = {}) =>
      requestRatelApi<T>({ context: runtimeContext, token }, path, init),
    [runtimeContext, token],
  );

  const configQuery = useQuery({
    ...ratelApiQueryOptions<ConfigResponse>({
      context: runtimeContext,
      path: "/api/config",
      queryKey: ratelQueryKeys.config(runtimeContext),
      token,
    }),
    enabled: Boolean(token) && runtimeContext.kind !== "all",
  });
  const config = configQuery.data ?? null;
  const configError = configQuery.error?.message ?? null;
  const configLoading = configQuery.isPending && configQuery.fetchStatus === "fetching";

  const refresh = useCallback(async () => {
    if (runtimeContext.kind === "all") return;
    await queryClient.invalidateQueries({ queryKey: ratelQueryKeys.config(runtimeContext) });
  }, [queryClient, runtimeContext]);

  const agentHostsQuery = useQuery({
    ...ratelApiQueryOptions<AgentHostsResponse>({
      context: runtimeContext,
      path: "/api/agent-hosts",
      queryKey: ratelQueryKeys.agentHosts(runtimeContext),
      token,
    }),
    enabled: Boolean(token) && runtimeContext.kind !== "all",
  });
  const agentHosts = agentHostsQuery.data?.hosts ?? [];

  const projectsQuery = useQuery({
    ...ratelApiQueryOptions<unknown>({
      context: runtimeContext,
      path: "/api/projects",
      queryKey: ratelQueryKeys.projects(),
      token,
    }),
    enabled: Boolean(token),
    select: projectsFromResponse,
  });
  const projects = projectsQuery.data ?? [];
  const projectsError = projectsQuery.error?.message ?? null;
  const projectsLoading = projectsQuery.isPending && projectsQuery.fetchStatus === "fetching";
  const refreshProjects = useCallback(async () => {
    if (!token) return;
    await queryClient.invalidateQueries({ queryKey: ratelQueryKeys.projects() });
  }, [queryClient, token]);

  useEffect(() => {
    const rememberedPath =
      location.pathname === "/"
        ? safeRememberedRoute(window.localStorage.getItem(LAST_ROUTE_STORAGE_KEY))
        : null;
    const redirectPath = rememberedPath ?? legacyGlobalPath(location.pathname);
    if (redirectPath) {
      void navigate({ replace: true, to: `${redirectPath}${location.searchStr}` } as never);
      return;
    }
    window.localStorage.setItem(LAST_ROUTE_STORAGE_KEY, location.pathname);
  }, [location.pathname, location.searchStr, navigate]);

  const pagePath = useCallback(
    (page: string) => withToken(contextPagePath(runtimeContext, page), token),
    [runtimeContext, token],
  );

  const goTo = useCallback(
    (to: PrimaryDestination) => {
      void navigate({ to: pagePath(to) } as never);
    },
    [navigate, pagePath],
  );

  const goToToolSource = useCallback(
    (scope: RatelScope, name: string) => {
      const path = toolSourcePath(scope, name, token, runtimeContext);
      void navigate({ to: path } as never);
    },
    [navigate, runtimeContext, token],
  );

  const goToAgent = useCallback(
    (kind: AgentHostKind) => {
      const path = agentSetupHostPath(kind, token, runtimeContext);
      void navigate({ to: path } as never);
    },
    [navigate, runtimeContext, token],
  );

  const selectContext = useCallback(
    (nextContext: RuntimeUiContext) => {
      const suffix = runtimeContextKind === "all" ? "/" : pageSuffixFromPathname(location.pathname);
      const path = contextPagePath(nextContext, suffix);
      void navigate({ to: withToken(path, token) } as never);
    },
    [location.pathname, navigate, runtimeContextKind, token],
  );
  const refreshCurrentContext = useCallback(
    () => (runtimeContext.kind === "all" ? refreshProjects() : refresh()),
    [refresh, refreshProjects, runtimeContext.kind],
  );

  useHotkey(COMMAND_MENU_SHORTCUT.hotkey, () => setCommandOpen((open) => !open), {
    meta: {
      name: COMMAND_MENU_SHORTCUT.label,
      description: "Toggle the Ratel command menu.",
    },
  });
  useHotkey(REFRESH_SHORTCUT.hotkey, () => void refreshCurrentContext(), {
    meta: {
      name: REFRESH_SHORTCUT.label,
      description: "Reload the selected Ratel Local context.",
    },
    preventDefault: true,
  });

  const context: RatelAppContextValue = {
    config,
    configError,
    configLoading,
    context: runtimeContext,
    pagePath,
    projects,
    projectsError,
    projectsLoading,
    request,
    refresh,
    refreshProjects,
    setupIntent,
    token,
    clearSetupIntent: () => setSetupIntent(null),
    triggerSetupIntent: (kind) => setSetupIntent({ id: Date.now(), kind }),
  };

  return (
    <RatelAppContext.Provider value={context}>
      <div className="min-h-dvh">
        <AppHeader
          config={config}
          context={runtimeContext}
          homePath={pagePath("/")}
          onSearch={() => {
            setCommandOpen(true);
            void agentHostsQuery.refetch();
          }}
          onSelectContext={selectContext}
          projects={projects}
        />
        <div className="mx-auto flex max-w-7xl flex-col md:flex-row">
          <ProductSidebar
            context={runtimeContext}
            pagePath={pagePath}
            pathname={location.pathname}
          />
          <div className="min-w-0 flex-1 [&>main]:!px-6 [&>main]:!py-8">
            {!token ? (
              <main className="w-full">
                <Alert>
                  <AlertTitle>Missing session token</AlertTitle>
                  <AlertDescription>Open the URL printed by ratel-local ui.</AlertDescription>
                </Alert>
              </main>
            ) : (
              <Outlet />
            )}
          </div>
        </div>
      </div>

      <CommandMenu
        agentHosts={agentHosts}
        config={config}
        onAddToolSource={() => {
          setCommandOpen(false);
          void navigate({ to: toolSourceCreatePath("user", token, runtimeContext) } as never);
        }}
        onImport={() => {
          setCommandOpen(false);
          context.triggerSetupIntent("import");
          goTo("/agent-setup");
        }}
        onLink={() => {
          setCommandOpen(false);
          context.triggerSetupIntent("link");
          goTo("/agent-setup");
        }}
        onNavigate={(to) => {
          setCommandOpen(false);
          goTo(to);
        }}
        onSelectToolSource={(scope, name) => {
          setCommandOpen(false);
          goToToolSource(scope, name);
        }}
        onSelectAgent={(kind) => {
          setCommandOpen(false);
          goToAgent(kind);
        }}
        open={commandOpen}
        readOnly={runtimeContext.kind === "all"}
        setOpen={setCommandOpen}
      />
      <Toaster />
    </RatelAppContext.Provider>
  );
}

function ProductSidebar({
  context,
  pagePath,
  pathname,
}: {
  context: RuntimeUiContext;
  pagePath: (page: string) => string;
  pathname: string;
}) {
  const pageSuffix = pageSuffixFromPathname(pathname);
  return (
    <aside className="flex gap-1 overflow-x-auto border-forest-300 border-b px-4 py-2 md:sticky md:top-16 md:h-[calc(100dvh-4rem)] md:w-56 md:shrink-0 md:flex-col md:overflow-visible md:border-r md:border-b-0 md:px-3 md:py-6">
      <nav aria-label="Primary" className="flex gap-1 md:flex-col">
        {context.kind === "all" ? (
          <ProductSidebarItem active icon={<LayoutGrid />} label="Overview" to={pagePath("/")} />
        ) : (
          <>
            <ProductSidebarItem
              active={pageSuffix === "/" || pageSuffix.startsWith("/tools/")}
              icon={<Server />}
              label="Tools"
              to={pagePath("/")}
            />
            <ProductSidebarItem
              active={pageSuffix.startsWith("/skills")}
              icon={<Sparkles />}
              label="Skills"
              to={pagePath("/skills")}
            />
            <ProductSidebarItem
              active={pageSuffix.startsWith("/agent-setup")}
              icon={<Settings2 />}
              label="Agent Setup"
              to={pagePath("/agent-setup")}
            />
            <ProductSidebarItem
              active={pageSuffix === "/clients"}
              icon={<RadioTower />}
              label="Clients"
              to={pagePath("/clients")}
            />
            <ProductSidebarItem
              active={pageSuffix === "/retrieval"}
              icon={<SlidersHorizontal />}
              label="Retrieval"
              to={pagePath("/retrieval")}
            />
          </>
        )}
      </nav>
    </aside>
  );
}

function AppHeader({
  config,
  context,
  homePath,
  onSearch,
  onSelectContext,
  projects,
}: {
  config: ConfigResponse | null;
  context: RuntimeUiContext;
  homePath: string;
  onSearch: () => void;
  onSelectContext: (context: RuntimeUiContext) => void;
  projects: readonly ProjectView[];
}) {
  return (
    <header className="sticky top-0 z-20 border-forest-300 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-6">
        <Link
          aria-label="Ratel Local home"
          className="flex shrink-0 items-center text-cream"
          preload="intent"
          to={homePath}
        >
          <BrandLogo />
        </Link>
        <span aria-hidden className="h-5 w-px bg-forest-300" />
        <ContextSwitcher context={context} onSelect={onSelectContext} projects={projects} />
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            className="hidden h-9 gap-2 border-0 bg-transparent px-2.5 text-cream-dim hover:bg-forest/40 hover:text-cream sm:inline-flex"
            onClick={onSearch}
            type="button"
            variant="ghost"
          >
            <Search className="size-4" />
            <span className="text-sm">Search</span>
            <ShortcutHint
              className="ml-1"
              keyClassName="bg-forest/60 px-1.5 text-cream-dim ring-1 ring-forest-300 ring-inset"
              shortcut={COMMAND_MENU_SHORTCUT.hotkey}
            />
          </Button>
          <Button
            aria-label="Search"
            className="sm:hidden"
            onClick={onSearch}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Search />
          </Button>
          <SessionMenu config={config} />
        </div>
      </div>
    </header>
  );
}

function ProductSidebarItem({
  active,
  icon,
  label,
  suffix,
  to,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  suffix?: ReactNode;
  to: string;
}) {
  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0",
        active ? "bg-forest text-cream" : "text-cream-dim hover:bg-forest/40 hover:text-cream",
      )}
      preload="intent"
      to={to}
    >
      {icon}
      <span className="whitespace-nowrap">{label}</span>
      {suffix}
    </Link>
  );
}

function SessionMenu({ config }: { config: ConfigResponse | null }) {
  const homeLabel = compactPathLabel(config?.homeDir) ?? "Local machine";
  const projectLabel = compactPathLabel(config?.projectRoot) ?? "No project root";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button aria-label="Session menu" size="icon-sm" variant="ghost" />}
      >
        <UserCircle />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64 rounded-lg" side="bottom" sideOffset={8}>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
              <Avatar>
                <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground [&>svg]:size-4">
                  <UserCircle />
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Session</span>
                <span className="truncate text-xs text-muted-foreground">{homeLabel}</span>
              </div>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 p-2 hover:bg-transparent focus:bg-transparent">
            <House className="mt-0.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Home</span>
            <span className="col-start-2 truncate font-mono text-xs">
              {config?.homeDir ?? "Not loaded"}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 p-2 hover:bg-transparent focus:bg-transparent">
            <FolderOpen className="mt-0.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Project</span>
            <span className="col-start-2 truncate font-mono text-xs">{projectLabel}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function compactPathLabel(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function CommandMenu(props: {
  agentHosts: DetectedAgentHostSummary[];
  config: ConfigResponse | null;
  onAddToolSource: () => void;
  onImport: () => void;
  onLink: () => void;
  onNavigate: (to: PrimaryDestination) => void;
  onSelectAgent: (kind: AgentHostKind) => void;
  onSelectToolSource: (scope: RatelScope, name: string) => void;
  open: boolean;
  readOnly: boolean;
  setOpen: (open: boolean) => void;
}) {
  const agentItems = commandAgentItems(props.agentHosts);
  const mcpItems = commandMcpItems(props.config);

  return (
    <Dialog open={props.open} onOpenChange={props.setOpen}>
      <DialogContent
        className="top-1/3 translate-y-0 overflow-hidden p-0"
        showCloseButton={false}
        style={{ maxWidth: "min(calc(100% - 2.75rem), 36rem)" }}
      >
        <Command>
          <CommandInput placeholder="Search Ratel..." />
          <CommandList>
            <CommandEmpty>No matching command.</CommandEmpty>
            <CommandGroup heading="Navigate">
              <CommandItem onSelect={() => props.onNavigate("/")}>
                <Server />
                Tools
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/skills")}>
                <Sparkles />
                Skills
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/agent-setup")}>
                <Settings2 />
                Agent Setup
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/clients")}>
                <RadioTower />
                Clients
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/retrieval")}>
                <SlidersHorizontal />
                Retrieval
              </CommandItem>
            </CommandGroup>
            {agentItems.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Agents">
                  {agentItems.map((item) => (
                    <CommandItem
                      className="items-start py-2"
                      key={item.kind}
                      onSelect={() => props.onSelectAgent(item.kind)}
                      value={`${item.displayName} ${item.kind} ${item.statusLabel} ${item.postureLabel} ${item.nativeEntryCount} native ${item.connectionDetail} ${item.missingRatelEntryCount} missing ${item.searchText}`}
                    >
                      <Settings2 className="mt-0.5" />
                      <span className="grid min-w-0 flex-1 gap-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{item.displayName}</span>
                          <CommandStatusBadge tone={item.statusTone}>
                            {item.statusLabel}
                          </CommandStatusBadge>
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {item.postureLabel} / {item.nativeEntryCount} native /{" "}
                          {item.connectionDetail}
                          {item.missingRatelEntryCount > 0
                            ? ` / ${item.missingRatelEntryCount} missing`
                            : ""}
                        </span>
                      </span>
                      <CommandShortcut className="font-mono tracking-normal">
                        {item.kind}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {mcpItems.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="MCP Sources">
                  {mcpItems.map((item) => (
                    <CommandItem
                      className="items-start py-2"
                      key={`${item.scope}:${item.name}`}
                      onSelect={() => props.onSelectToolSource(item.scope, item.name)}
                      value={`${item.name} ${item.scope} ${item.type} ${item.summary}`}
                    >
                      <Server className="mt-0.5" />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate font-medium">{item.name}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {item.summary}
                        </span>
                      </span>
                      <CommandShortcut className="font-mono tracking-normal">
                        {item.scope}
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            {!props.readOnly && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Actions">
                  <CommandItem onSelect={props.onAddToolSource}>
                    <Plus />
                    Add tool source
                  </CommandItem>
                  <CommandItem onSelect={props.onImport}>
                    <Download />
                    Import from agent
                  </CommandItem>
                  <CommandItem onSelect={props.onLink}>
                    <LinkIcon />
                    Link agent to Ratel
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function commandMcpItems(config: ConfigResponse | null) {
  return SCOPES.flatMap((scope) => {
    const scopeState = config?.scopes[scope];
    if (!scopeState?.available) return [];
    return Object.entries(scopeState.config.mcpServers).map(([name, entry]) => ({
      entry,
      name,
      scope,
      summary: summaryOf(entry),
      type: entry.type || "stdio",
    }));
  }).sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
}

function commandAgentItems(hosts: readonly DetectedAgentHostSummary[]) {
  return hosts
    .map((host) => {
      const status = commandAgentStatus(host);
      return {
        displayName: host.displayName,
        connectionDetail: commandAgentConnectionDetail(host),
        kind: host.kind,
        missingRatelEntryCount: host.missingRatelEntryNames?.length ?? 0,
        nativeEntryCount: host.nativeEntryCount,
        postureLabel: AGENT_POSTURE_LABELS[host.posture],
        searchText: [
          host.detection.reasons.join(" "),
          host.detection.warnings.join(" "),
          host.nativeEntryNames?.join(" "),
          host.ratelEntryNames?.join(" "),
          host.connection.kind,
          host.scopes.map((scope) => scope.path).join(" "),
        ].join(" "),
        statusLabel: status.label,
        statusTone: status.tone,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function commandAgentConnectionDetail(host: DetectedAgentHostSummary): string {
  if (host.connection.kind === "duplicate") {
    return `plugin + ${host.ratelEntryCount} explicit Ratel`;
  }
  if (host.connection.kind === "plugin") return "Ratel plugin";
  return `${host.ratelEntryCount} Ratel`;
}

const AGENT_POSTURE_LABELS: Record<AgentPosture, string> = {
  empty: "No MCP entries",
  mixed: "Native entries with Ratel",
  "not-linked": "Native entries only",
  "ratel-only": "Ratel connected",
  unavailable: "Config unavailable",
};

function commandAgentStatus(host: DetectedAgentHostSummary): {
  label: string;
  tone: "muted" | "success" | "warning";
} {
  if (host.posture === "unavailable") return { label: "Unavailable", tone: "muted" };
  if (host.connection.kind === "duplicate") {
    return { label: "Duplicate", tone: "warning" };
  }
  if (host.connection.linked && (host.missingRatelEntryNames?.length ?? 0) === 0) {
    return { label: "Linked", tone: "success" };
  }
  if (host.connection.linked) return { label: "Mixed", tone: "warning" };
  return { label: "Not linked", tone: "muted" };
}

function CommandStatusBadge(props: { children: ReactNode; tone: "muted" | "success" | "warning" }) {
  return (
    <Badge
      className={cn(
        "h-5 rounded-full px-2 text-[10px]",
        props.tone === "success" &&
          "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200",
        props.tone === "warning" &&
          "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200",
        props.tone === "muted" && "border-border bg-muted text-muted-foreground",
      )}
      variant="outline"
    >
      {props.children}
    </Badge>
  );
}

export function useRatelApp() {
  const context = useContext(RatelAppContext);
  if (!context) {
    throw new Error("useRatelApp must be used within AppShell");
  }
  return context;
}

export function authBadgeVariant(status?: AuthStatus) {
  if (status === "needs auth") return "warning" as const;
  if (status === "expired") return "muted" as const;
  if (status === "unsupported") return "destructive" as const;
  return "outline" as const;
}

export function toolSourcePath(
  scope: RatelScope,
  name: string,
  token?: string,
  context: RuntimeUiContext = { kind: "global" },
) {
  const path = contextPagePath(
    context,
    `/tools/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`,
  );
  return withToken(path, token);
}

export function skillPath(
  id: string,
  token?: string,
  context: RuntimeUiContext = { kind: "global" },
) {
  const path = contextPagePath(context, `/skills/${encodeURIComponent(id)}`);
  return withToken(path, token);
}

export function toolSourceCreatePath(
  scope: RatelScope,
  token?: string,
  context: RuntimeUiContext = { kind: "global" },
) {
  const search = new URLSearchParams({ scope });
  if (token) search.set("t", token);
  return `${contextPagePath(context, "/tools/new")}?${search.toString()}`;
}

function agentSetupHostPath(
  kind: AgentHostKind,
  token?: string,
  context: RuntimeUiContext = { kind: "global" },
) {
  return withToken(contextPagePath(context, `/agent-setup/${kind}`), token);
}

function withToken(path: string, token?: string): string {
  if (!token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}t=${encodeURIComponent(token)}`;
}

export function summaryOf(entry: ServerEntry): string {
  const type = entry.type || "stdio";
  if (type === "stdio") {
    const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
    return `${entry.command ?? "<no command>"}${args}`;
  }
  return entry.url ?? "<no url>";
}

export function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseKeyValueLines(value: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

export function keyValsToText(
  value: Record<string, string> | undefined,
  separator: string,
): string {
  return Object.entries(value ?? {})
    .map(([key, val]) => `${key}${separator}${val}`)
    .join("\n");
}

function tokenFromSearch(searchStr: string | undefined): string {
  const search = searchStr ?? window.location.search;
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`).get("t") ?? "";
}

export default AppShell;
