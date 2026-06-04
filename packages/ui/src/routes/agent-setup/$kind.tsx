import { createFileRoute } from "@tanstack/react-router";
import { AgentDetailPage } from "@/pages/AgentSetupPage";

type AppSearch = {
  operation?: "import" | "link";
  t?: string;
};

export const Route = createFileRoute("/agent-setup/$kind")({
  validateSearch,
  component: AgentDetailRoute,
});

function AgentDetailRoute() {
  const { kind } = Route.useParams();
  const search = Route.useSearch();
  const hostKind = kind === "codex" ? "codex" : "claude-code";
  return <AgentDetailPage kind={hostKind} operation={search.operation} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    operation:
      search.operation === "import" || search.operation === "link" ? search.operation : undefined,
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
