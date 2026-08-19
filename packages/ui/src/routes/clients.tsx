import { createFileRoute } from "@tanstack/react-router";
import { McpClientsPage } from "@/pages/McpClientsPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/clients")({
  validateSearch,
  component: McpClientsPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
