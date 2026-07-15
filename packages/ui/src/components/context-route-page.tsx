import { useLocation } from "@tanstack/react-router";
import { AgentDetailPage, AgentSetupPage } from "@/pages/AgentSetupPage";
import { McpClientsPage } from "@/pages/McpClientsPage";
import { SkillDetailPage } from "@/pages/SkillDetailPage";
import { SkillsPage } from "@/pages/SkillsPage";
import { ToolSourceCreatePage, ToolSourceDetailPage, ToolsPage } from "@/pages/ToolsPage";

interface ContextRoutePageProps {
  subpath?: string;
}

export function ContextRoutePage({ subpath = "" }: ContextRoutePageProps) {
  const location = useLocation();
  const search = new URLSearchParams(location.searchStr);
  const segments = subpath.split("/").filter(Boolean).map(decodeSegment);

  if (segments.length === 0) return <ToolsPage />;
  if (segments[0] === "clients" && segments.length === 1) return <McpClientsPage />;
  if (segments[0] === "skills" && segments.length === 1) return <SkillsPage />;
  if (segments[0] === "skills" && segments.length === 2) {
    return <SkillDetailPage id={segments[1]} />;
  }
  if (segments[0] === "tools" && segments[1] === "new" && segments.length === 2) {
    return <ToolSourceCreatePage scope={search.get("scope") ?? "user"} />;
  }
  if (segments[0] === "tools" && segments.length === 3) {
    return <ToolSourceDetailPage scope={segments[1]} name={segments[2]} />;
  }
  if (segments[0] === "agent-setup" && segments.length === 1) return <AgentSetupPage />;
  if (segments[0] === "agent-setup" && segments.length === 2) {
    return (
      <AgentDetailPage
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
