import { createFileRoute } from "@tanstack/react-router";
import { AgentSetupPage } from "@/pages/AgentSetupPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/agent-setup")({
  validateSearch,
  component: AgentSetupPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
