import { createFileRoute } from "@tanstack/react-router";
import { ToolsPage } from "@/pages/ToolsPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/")({
  validateSearch,
  component: ToolsPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
