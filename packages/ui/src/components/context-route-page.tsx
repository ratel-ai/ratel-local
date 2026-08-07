import type { QueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import type { ConfigResponse } from "@/App";
import { ratelApiQueryOptions, ratelQueryKeys } from "@/lib/ratel-query";
import type { RuntimeUiContext } from "@/lib/runtime-context";
import { discoveredSkillSummaries, type SkillsResponse } from "@/lib/skills";
import { agentSettingsPageEnabled } from "@/lib/ui-features";
import {
  AgentDetailPage,
  AgentSetupPage,
  type AgentSetupRouteData,
  agentHostsFromResponse,
  LegacyAgentSetupRedirect,
} from "@/pages/AgentSetupPage";
import { McpClientsPage } from "@/pages/McpClientsPage";
import { SettingsPage } from "@/pages/RetrievalSettingsPage";
import { SkillDetailPage } from "@/pages/SkillDetailPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { ToolSourceCreatePage, ToolSourceDetailPage, ToolsPage } from "@/pages/ToolsPage";

const AGENT_SETTINGS_ENABLED = agentSettingsPageEnabled();

interface ContextRoutePageProps {
  routeData?: ContextRouteData;
  subpath?: string;
}

export interface ContextRouteData {
  agentSetup?: AgentSetupRouteData;
}

export function ContextRoutePage({ routeData, subpath = "" }: ContextRoutePageProps) {
  const location = useLocation();
  const search = new URLSearchParams(location.searchStr);
  const segments = subpath.split("/").filter(Boolean).map(decodeSegment);

  if (segments.length === 0) return <ToolsPage />;
  if (segments[0] === "clients" && segments.length === 1) return <McpClientsPage />;
  if (segments[0] === "skills" && segments.length === 1) return <SkillsPage />;
  if (["settings", "retrieval"].includes(segments[0] ?? "") && segments.length === 1) {
    return <SettingsPage initialAgentData={routeData?.agentSetup} />;
  }
  if (segments[0] === "skills" && segments.length === 2) {
    return <SkillDetailPage id={segments[1]} />;
  }
  if (segments[0] === "tools" && segments[1] === "new" && segments.length === 2) {
    return <ToolSourceCreatePage scope={search.get("scope") ?? "user"} />;
  }
  if (segments[0] === "tools" && segments.length === 3) {
    return <ToolSourceDetailPage scope={segments[1]} name={segments[2]} />;
  }
  if (segments[0] === "agent-setup" && segments.length === 1) {
    return AGENT_SETTINGS_ENABLED ? (
      <LegacyAgentSetupRedirect />
    ) : (
      <AgentSetupPage initialData={routeData?.agentSetup} />
    );
  }
  if (segments[0] === "agent-setup" && segments.length === 2) {
    return (
      <AgentDetailPage
        initialData={routeData?.agentSetup}
        kind={segments[1] === "codex" ? "codex" : "claude-code"}
        operation={operationFromSearch(search.get("operation"))}
      />
    );
  }

  return (
    <main className="grid min-h-72 place-items-center px-6 text-center">
      <div className="grid max-w-sm gap-2">
        <h1 className="font-medium text-xl">Page not found</h1>
        <p className="text-muted-foreground text-sm">
          This page does not exist in the selected runtime context.
        </p>
      </div>
    </main>
  );
}

export async function loadContextRouteData(input: {
  context: RuntimeUiContext;
  queryClient: QueryClient;
  signal: AbortSignal;
  subpath?: string;
  token?: string;
}): Promise<ContextRouteData> {
  const segments = (input.subpath ?? "").split("/").filter(Boolean);
  if (!["agent-setup", "settings"].includes(segments[0] ?? "") || !input.token) return {};

  const token = input.token;

  const [hosts, available, config] = await Promise.all([
    input.queryClient
      .ensureQueryData(
        ratelApiQueryOptions<unknown>({
          context: input.context,
          path: "/api/agent-hosts",
          queryKey: ratelQueryKeys.agentHosts(input.context),
          signal: input.signal,
          token,
        }),
      )
      .then(agentHostsFromResponse, () => []),
    input.queryClient
      .ensureQueryData(
        ratelApiQueryOptions<SkillsResponse>({
          context: input.context,
          path: "/api/skills",
          queryKey: ratelQueryKeys.skills(input.context),
          signal: input.signal,
          token,
        }),
      )
      .then(discoveredSkillSummaries, () => []),
    input.queryClient
      .ensureQueryData(
        ratelApiQueryOptions<ConfigResponse>({
          context: input.context,
          path: "/api/config",
          queryKey: ratelQueryKeys.config(input.context),
          signal: input.signal,
          token,
        }),
      )
      .catch(() => null),
  ]);
  return { agentSetup: { available, backups: config?.backups ?? [], hosts } };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function operationFromSearch(value: string | null): "import" | "link" | undefined {
  return value === "import" || value === "link" ? value : undefined;
}
