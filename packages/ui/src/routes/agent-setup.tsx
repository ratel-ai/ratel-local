import { createFileRoute } from "@tanstack/react-router";
import { loadContextRouteData } from "@/components/context-route-page";
import { AgentSetupPage } from "@/pages/AgentSetupPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/agent-setup")({
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
  component: AgentSetupRoute,
});

function AgentSetupRoute() {
  return <AgentSetupPage initialData={Route.useLoaderData().agentSetup} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
