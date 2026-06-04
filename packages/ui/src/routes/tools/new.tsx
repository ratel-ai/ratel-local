import { createFileRoute } from "@tanstack/react-router";
import { ToolSourceCreatePage } from "@/pages/ToolsPage";

type AppSearch = {
  scope?: string;
  t?: string;
};

export const Route = createFileRoute("/tools/new")({
  validateSearch,
  component: ToolSourceCreateRoute,
});

function ToolSourceCreateRoute() {
  const search = Route.useSearch();
  return <ToolSourceCreatePage scope={search.scope ?? "user"} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    scope: typeof search.scope === "string" ? search.scope : undefined,
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
