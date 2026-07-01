import { createFileRoute } from "@tanstack/react-router";
import { OnboardingPage } from "@/pages/OnboardingPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/onboarding")({
  validateSearch,
  component: OnboardingPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
