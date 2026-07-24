import { useLocation } from "@tanstack/react-router";
import type { ConfigResponse } from "@/App";
import { contextualizeApiPath, type RuntimeUiContext } from "@/lib/runtime-context";
import { discoveredSkillSummaries, type SkillsResponse } from "@/lib/skills";
import {
  AgentDetailPage,
  AgentSetupPage,
  type AgentSetupRouteData,
  agentHostsFromResponse,
} from "@/pages/AgentSetupPage";
import { McpClientsPage } from "@/pages/McpClientsPage";
import { RetrievalSettingsPage } from "@/pages/RetrievalSettingsPage";
import { SkillDetailPage } from "@/pages/SkillDetailPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { ToolSourceCreatePage, ToolSourceDetailPage, ToolsPage } from "@/pages/ToolsPage";

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
  if (segments[0] === "retrieval" && segments.length === 1) {
    return <RetrievalSettingsPage />;
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
    return <AgentSetupPage initialData={routeData?.agentSetup} />;
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
  signal: AbortSignal;
  subpath?: string;
  token?: string;
}): Promise<ContextRouteData> {
  const segments = (input.subpath ?? "").split("/").filter(Boolean);
  if (segments[0] !== "agent-setup" || !input.token) return {};

  const request = async <T,>(path: string): Promise<T> => {
    const headers = new Headers({ Authorization: `Bearer ${input.token}` });
    const response = await fetch(contextualizeApiPath(path, input.context), {
      headers,
      signal: input.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String(payload.error)
          : `${response.status} ${response.statusText}`;
      throw new Error(message);
    }
    return payload as T;
  };

  const [hosts, available, config] = await Promise.all([
    request<unknown>("/api/agent-hosts").then(agentHostsFromResponse, () => []),
    request<SkillsResponse>("/api/skills").then(discoveredSkillSummaries, () => []),
    request<ConfigResponse>("/api/config").catch(() => null),
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
