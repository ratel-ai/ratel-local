import { createFileRoute } from "@tanstack/react-router";
import { LegacyAgentSetupRedirect } from "@/pages/AgentSetupPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/agent-setup")({
  validateSearch,
  component: AgentSetupRoute,
});

function AgentSetupRoute() {
  return <LegacyAgentSetupRedirect />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
