import { createFileRoute } from "@tanstack/react-router";
import { SkillsPage } from "@/pages/SkillsPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/skills")({
  validateSearch,
  component: SkillsPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
