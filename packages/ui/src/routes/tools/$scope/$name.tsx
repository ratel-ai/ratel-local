import { createFileRoute } from "@tanstack/react-router";
import { ToolSourceDetailPage } from "@/pages/ToolsPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/tools/$scope/$name")({
  validateSearch,
  component: ToolSourceDetailRoute,
});

function ToolSourceDetailRoute() {
  const { name, scope } = Route.useParams();
  return <ToolSourceDetailPage name={name} scope={scope} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
