import { createFileRoute } from "@tanstack/react-router";
import { ContextRoutePage } from "@/components/context-route-page";

export const Route = createFileRoute("/global/$")({
  component: GlobalContextRoute,
});

function GlobalContextRoute() {
  const { _splat } = Route.useParams();
  return <ContextRoutePage subpath={_splat} />;
}
