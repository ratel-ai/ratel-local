import { createFileRoute } from "@tanstack/react-router";
import { AllProjectsPage } from "@/pages/AllProjectsPage";

export const Route = createFileRoute("/all")({
  component: AllProjectsPage,
});
