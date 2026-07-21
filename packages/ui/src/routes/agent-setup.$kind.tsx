import { createFileRoute } from "@tanstack/react-router";
import { loadContextRouteData } from "@/components/context-route-page";
import { AgentDetailPage } from "@/pages/AgentSetupPage";

type AppSearch = {
  operation?: "import" | "link";
  t?: string;
};

export const Route = createFileRoute("/agent-setup/$kind")({
  validateSearch,
  loaderDeps: ({ search }) => ({ token: search.t }),
  loader: ({ abortController, deps }) =>
    loadContextRouteData({
      context: { kind: "global" },
      signal: abortController.signal,
      subpath: "agent-setup",
      token: deps.token,
    }),
  staleTime: 10_000,
  component: AgentDetailRoute,
});

function AgentDetailRoute() {
  const { kind } = Route.useParams();
  const search = Route.useSearch();
  const hostKind = kind === "codex" ? "codex" : "claude-code";
  return (
    <AgentDetailPage
      initialData={Route.useLoaderData().agentSetup}
      kind={hostKind}
      operation={search.operation}
    />
  );
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    operation:
      search.operation === "import" || search.operation === "link" ? search.operation : undefined,
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
