import { createFileRoute } from "@tanstack/react-router";
import { loadContextRouteData } from "@/components/context-route-page";
import { agentSettingsPageEnabled } from "@/lib/ui-features";
import { AgentSetupPage, LegacyAgentSetupRedirect } from "@/pages/AgentSetupPage";

type AppSearch = {
  t?: string;
};

const AGENT_SETTINGS_ENABLED = agentSettingsPageEnabled();

export const Route = createFileRoute("/agent-setup")({
  validateSearch,
  loaderDeps: ({ search }) => ({ token: search.t }),
  loader: ({ abortController, context, deps }) =>
    loadContextRouteData({
      context: { kind: "global" },
      queryClient: context.queryClient,
      signal: abortController.signal,
      subpath: "agent-setup",
      token: deps.token,
    }),
  staleTime: 10_000,
  component: AgentSetupRoute,
});

function AgentSetupRoute() {
  const routeData = Route.useLoaderData();
  if (AGENT_SETTINGS_ENABLED) return <LegacyAgentSetupRedirect />;
  return <AgentSetupPage initialData={routeData.agentSetup} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
