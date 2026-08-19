import { createFileRoute } from "@tanstack/react-router";
import { ContextRoutePage } from "@/components/context-route-page";

export const Route = createFileRoute("/projects/$projectId")({
  component: ContextRoutePage,
});
