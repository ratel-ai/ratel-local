import { createFileRoute } from "@tanstack/react-router";
import { SkillDetailPage } from "@/pages/SkillDetailPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/skills/$id")({
  validateSearch,
  component: SkillDetailRoute,
});

function SkillDetailRoute() {
  const { id } = Route.useParams();
  return <SkillDetailPage id={id} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
