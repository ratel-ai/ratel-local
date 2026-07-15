import { createFileRoute } from "@tanstack/react-router";
import { ContextRoutePage } from "@/components/context-route-page";

export const Route = createFileRoute("/projects/$projectId/$")({
  component: ProjectContextRoute,
});

function ProjectContextRoute() {
  const { _splat } = Route.useParams();
  return <ContextRoutePage subpath={_splat} />;
}
