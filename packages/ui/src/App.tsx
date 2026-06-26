import { useHotkey } from "@tanstack/react-hotkeys";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Download,
  FolderOpen,
  House,
  LayoutGrid,
  LinkIcon,
  Moon,
  Plus,
<<<<<<< HEAD
  RadioTower,
=======
  Search,
>>>>>>> 23f0c8f (feat(ui): dark Cloud-style theme + header/rail shell)
  Server,
  Settings2,
  Sparkles,
  Sun,
  UserCircle,
} from "lucide-react";
<<<<<<< HEAD
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
=======
import { useTheme } from "next-themes";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
>>>>>>> 23f0c8f (feat(ui): dark Cloud-style theme + header/rail shell)
import { toast } from "sonner";
import { BrandLogo } from "@/components/brand-logo";
import { ContextSwitcher } from "@/components/context-switcher";
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
import { type ProjectView, projectsFromResponse } from "@/lib/projects";
import {
  contextPagePath,
  contextualizeApiPath,
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
}

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

export type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };
type SetupIntent = { id: number; kind: "import" | "link" };

interface RatelAppContextValue {
  busy: boolean;
  config: ConfigResponse | null;
  context: RuntimeUiContext;
  pagePath: (page: string) => string;
  projects: ProjectView[];
  projectsError: string | null;
  projectsLoading: boolean;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  refresh: () => Promise<void>;
  refreshProjects: () => Promise<void>;
  runAction: (
    label: string,
    action: () => Promise<{ log?: string[] } | unknown>,
  ) => Promise<boolean>;
  setupIntent: SetupIntent | null;
  token: string;
  clearSetupIntent: () => void;
  openCommandMenu: () => void;
  triggerSetupIntent: (kind: SetupIntent["kind"]) => void;
}

const RatelAppContext = createContext<RatelAppContextValue | null>(null);

export const SCOPES: RatelScope[] = ["user", "project", "local"];
const LAST_ROUTE_STORAGE_KEY = "ratel:last-route:v1";

export function AppShell() {
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
  const runtimeContextKey =
    runtimeContext.kind === "project" ? `project:${runtimeContext.projectId}` : runtimeContext.kind;
  const [configState, setConfigState] = useState<{
    contextKey: string;
    value: ConfigResponse | null;
  }>({ contextKey: "", value: null });
  const [agentHostsState, setAgentHostsState] = useState<{
    contextKey: string;
    value: DetectedAgentHostSummary[];
  }>({ contextKey: "", value: [] });
  const config = configState.contextKey === runtimeContextKey ? configState.value : null;
  const agentHosts = agentHostsState.contextKey === runtimeContextKey ? agentHostsState.value : [];
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [setupIntent, setSetupIntent] = useState<SetupIntent | null>(null);

  const notify = useCallback((message: string, kind?: "error") => {
    const [title, ...description] = message.split("\n");
    const options = { description: description.join("\n") || undefined };
    if (kind === "error") {
      toast.error(title, options);
      return;
    }
    toast.success(title, options);
  }, []);

  const request = useCallback(
    async <T,>(path: string, init: JsonRequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const body =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : JSON.stringify(init.body);
      if (body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const requestPath = contextualizeApiPath(path, runtimeContext, init.method ?? "GET");
      const res = await fetch(requestPath, { ...init, headers, body });
      const payload = await readJson(res);
      if (!res.ok) {
        const message =
          payload && typeof payload.error === "string"
            ? payload.error
            : `${res.status} ${res.statusText}`;
        throw new Error(message);
      }
      return payload as T;
    },
    [runtimeContext, token],
  );

  const refresh = useCallback(async () => {
    if (runtimeContext.kind === "all") {
      setConfigState({ contextKey: runtimeContextKey, value: null });
      return;
    }
    try {
      const value = await request<ConfigResponse>("/api/config");
      setConfigState({ contextKey: runtimeContextKey, value });
    } catch (err) {
      notify((err as Error).message, "error");
    }
  }, [notify, request, runtimeContext.kind, runtimeContextKey]);

  useEffect(() => {
    if (token && runtimeContext.kind !== "all") void refresh();
  }, [refresh, runtimeContext.kind, token]);

  const refreshAgentHosts = useCallback(async () => {
    if (!token || runtimeContext.kind === "all") return;
    try {
      const body = await request<AgentHostsResponse>("/api/agent-hosts");
      setAgentHostsState({ contextKey: runtimeContextKey, value: body.hosts });
    } catch (err) {
      notify((err as Error).message, "error");
    }
  }, [notify, request, runtimeContext.kind, runtimeContextKey, token]);

  useEffect(() => {
    if (token && runtimeContext.kind !== "all") void refreshAgentHosts();
  }, [refreshAgentHosts, runtimeContext.kind, token]);

  useEffect(() => {
    if (commandOpen && token) void refreshAgentHosts();
  }, [commandOpen, refreshAgentHosts, token]);

  const refreshProjects = useCallback(async () => {
    if (!token) return;
    setProjectsLoading(true);
    try {
      const body = await request<unknown>("/api/projects");
      setProjects(projectsFromResponse(body));
      setProjectsError(null);
    } catch (err) {
      setProjectsError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setProjectsLoading(false);
    }
  }, [request, token]);

  useEffect(() => {
    if (token) void refreshProjects();
  }, [refreshProjects, token]);

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

  const runAction = useCallback(
    async (label: string, action: () => Promise<{ log?: string[] } | unknown>) => {
      setBusy(true);
      try {
        const result = await action();
        const log = isLogResult(result) ? result.log.slice(-3).join("\n") : "";
        notify(log ? `${label}\n${log}` : label);
        await refresh();
        return true;
      } catch (err) {
        notify((err as Error).message, "error");
        await refresh();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  const pagePath = useCallback(
    (page: string) => withToken(contextPagePath(runtimeContext, page), token),
    [runtimeContext, token],
  );

  const goTo = useCallback(
    (to: "/" | "/agent-setup" | "/skills" | "/clients") => {
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

  useHotkey("Mod+K", () => setCommandOpen((open) => !open), {
    meta: {
      name: "Open command menu",
      description: "Toggle the Ratel command menu.",
    },
  });
  useHotkey("Mod+R", () => void refreshCurrentContext(), {
    meta: {
      name: "Refresh current view",
      description: "Reload the selected Ratel Local context.",
    },
    preventDefault: true,
  });

  const context: RatelAppContextValue = {
    busy,
    config,
    context: runtimeContext,
    pagePath,
    projects,
    projectsError,
    projectsLoading,
    request,
    refresh,
    refreshProjects,
    runAction,
    setupIntent,
    token,
    clearSetupIntent: () => setSetupIntent(null),
    openCommandMenu: () => setCommandOpen(true),
    triggerSetupIntent: (kind) => setSetupIntent({ id: Date.now(), kind }),
  };

  return (
    <RatelAppContext.Provider value={context}>
<<<<<<< HEAD
      <SidebarProvider>
        <ProductSidebar
          config={config}
          context={runtimeContext}
          onNavigate={goTo}
          onSelectContext={selectContext}
          pathname={location.pathname}
          projects={projects}
        />
        <SidebarInset>
          {!token ? (
            <main className="w-full px-4 py-6 sm:px-6">
              <Alert>
                <AlertTitle>Missing session token</AlertTitle>
                <AlertDescription>Open the URL printed by ratel-local ui.</AlertDescription>
              </Alert>
            </main>
          ) : (
            <Outlet />
          )}
        </SidebarInset>
      </SidebarProvider>
=======
      <div className="min-h-dvh">
        <AppHeader config={config} onNavigate={goTo} onSearch={() => setCommandOpen(true)} />
        <div className="mx-auto flex max-w-7xl flex-col md:flex-row">
          <NavRail onNavigate={goTo} pathname={location.pathname} />
          <div className="min-w-0 flex-1">
            {!token ? (
              <main className="w-full px-4 py-6 sm:px-6">
                <Alert>
                  <AlertTitle>Missing session token</AlertTitle>
                  <AlertDescription>Open the URL printed by ratel-mcp ui.</AlertDescription>
                </Alert>
              </main>
            ) : (
              <Outlet />
            )}
          </div>
        </div>
      </div>
>>>>>>> 23f0c8f (feat(ui): dark Cloud-style theme + header/rail shell)

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

<<<<<<< HEAD
function ProductSidebar(props: {
  config: ConfigResponse | null;
  context: RuntimeUiContext;
  onNavigate: (to: "/" | "/agent-setup" | "/skills" | "/clients") => void;
  onSelectContext: (context: RuntimeUiContext) => void;
  pathname: string;
  projects: readonly ProjectView[];
}) {
  const pageSuffix = pageSuffixFromPathname(props.pathname);
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="cursor-default hover:bg-transparent" size="lg">
              <BrandLogo className="h-5 w-fit max-w-[92px] transition-[opacity,filter,transform] duration-200 ease-out group-data-[collapsible=icon]:translate-x-1 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:blur-[2px]" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <ContextSwitcher
          context={props.context}
          onSelect={props.onSelectContext}
          projects={props.projects}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1.5">
              {props.context.kind === "all" ? (
                <ProductSidebarItem
                  active
                  icon={<LayoutGrid />}
                  label="Overview"
                  onClick={() => props.onNavigate("/")}
                />
              ) : (
                <>
                  <ProductSidebarItem
                    active={pageSuffix === "/" || pageSuffix.startsWith("/tools/")}
                    icon={<Server />}
                    label="Tools"
                    onClick={() => props.onNavigate("/")}
                  />
                  <ProductSidebarItem
                    active={pageSuffix.startsWith("/agent-setup")}
                    icon={<Settings2 />}
                    label="Agent Setup"
                    onClick={() => props.onNavigate("/agent-setup")}
                  />
                  <ProductSidebarItem
                    active={pageSuffix === "/clients"}
                    icon={<RadioTower />}
                    label="Clients"
                    onClick={() => props.onNavigate("/clients")}
                  />
                  <ProductSidebarItem
                    active={pageSuffix.startsWith("/skills")}
                    icon={<Sparkles />}
                    label="Skills"
                    onClick={() => props.onNavigate("/skills")}
                  />
                </>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SessionMenu config={props.config} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
=======
type NavTarget = "/" | "/agent-setup" | "/skills";
>>>>>>> 23f0c8f (feat(ui): dark Cloud-style theme + header/rail shell)

const NAV_ITEMS: Array<{
  to: NavTarget;
  label: string;
  icon: ReactNode;
  isActive: (pathname: string) => boolean;
}> = [
  {
    to: "/",
    label: "Tools",
    icon: <Server />,
    isActive: (pathname) => pathname === "/" || pathname.startsWith("/tools/"),
  },
  {
    to: "/agent-setup",
    label: "Agent Setup",
    icon: <Settings2 />,
    isActive: (pathname) => pathname === "/agent-setup" || pathname.startsWith("/agent-setup/"),
  },
  {
    to: "/skills",
    label: "Skills",
    icon: <Sparkles />,
    isActive: (pathname) => pathname === "/skills" || pathname.startsWith("/skills/"),
  },
];

/**
 * Sticky top bar: brand mark + wordmark on the left, a ⌘K search affordance and
 * the session account menu on the right. Mirrors the Ratel Cloud header.
 */
function AppHeader(props: {
  config: ConfigResponse | null;
  onNavigate: (to: NavTarget) => void;
  onSearch: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 border-border border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
        <button
          aria-label="Ratel MCP home"
          className="flex shrink-0 items-center gap-2"
          onClick={() => props.onNavigate("/")}
          type="button"
        >
          <BrandLogo />
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            className="hidden h-9 gap-2 px-3 text-muted-foreground sm:inline-flex"
            onClick={props.onSearch}
            type="button"
            variant="outline"
          >
            <Search className="size-4" />
            <span className="text-sm">Search</span>
            <span className="ml-1 rounded border border-border px-1.5 font-mono text-xs leading-none">
              ⌘K
            </span>
          </Button>
          <Button
            aria-label="Search"
            className="sm:hidden"
            onClick={props.onSearch}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Search />
          </Button>
          <SessionMenu config={props.config} />
        </div>
      </div>
    </header>
  );
}

/**
 * Primary navigation. A sticky vertical rail under the header on desktop, a
 * horizontal scrolling strip on mobile (no off-canvas drawer to toggle).
 */
function NavRail(props: { onNavigate: (to: NavTarget) => void; pathname: string }) {
  return (
    <aside
      className={cn(
        "flex gap-1 overflow-x-auto border-border border-b px-4 py-2",
        "md:sticky md:top-16 md:h-[calc(100dvh-4rem)] md:w-56 md:shrink-0 md:flex-col md:gap-1 md:overflow-visible md:border-r md:border-b-0 md:px-3 md:py-6",
      )}
    >
      <nav className="flex gap-1 md:flex-col md:gap-1">
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(props.pathname);
          return (
            <button
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors [&_svg]:size-[18px] [&_svg]:shrink-0",
                active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              key={item.to}
              onClick={() => props.onNavigate(item.to)}
              type="button"
            >
              {item.icon}
              <span className="whitespace-nowrap">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

function SessionMenu(props: { config: ConfigResponse | null }) {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const homeLabel = compactPathLabel(props.config?.homeDir) ?? "Local machine";
  const projectLabel = compactPathLabel(props.config?.projectRoot) ?? "No project root";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Session menu"
            className="rounded-full"
            size="icon-sm"
            variant="ghost"
          />
        }
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
              {props.config?.homeDir ?? "Not loaded"}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 p-2 hover:bg-transparent focus:bg-transparent">
            <FolderOpen className="mt-0.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Project</span>
            <span className="col-start-2 truncate font-mono text-xs">{projectLabel}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            setTheme(isDark ? "light" : "dark");
          }}
        >
          {isDark ? <Sun /> : <Moon />}
          {isDark ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
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
  onNavigate: (to: "/" | "/agent-setup" | "/skills" | "/clients") => void;
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
                <CommandShortcut>G T</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/agent-setup")}>
                <Settings2 />
                Agent Setup
                <CommandShortcut>G A</CommandShortcut>
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/clients")}>
                <RadioTower />
                Clients
              </CommandItem>
              <CommandItem onSelect={() => props.onNavigate("/skills")}>
                <Sparkles />
                Skills
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
        "h-5 rounded-full px-2 text-xs",
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

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isLogResult(value: unknown): value is { log: string[] } {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { log?: unknown }).log)
  );
}

function tokenFromSearch(searchStr: string | undefined): string {
  const search = searchStr ?? window.location.search;
  return new URLSearchParams(search.startsWith("?") ? search : `?${search}`).get("t") ?? "";
}

export default AppShell;
