import { createFileRoute } from "@tanstack/react-router";
import { ContextRoutePage, loadContextRouteData } from "@/components/context-route-page";

type AppSearch = { t?: string };

export const Route = createFileRoute("/projects/$projectId/$")({
  validateSearch,
  loaderDeps: ({ search }) => ({ token: search.t }),
  loader: ({ abortController, deps, params }) =>
    loadContextRouteData({
      context: { kind: "project", projectId: params.projectId },
      signal: abortController.signal,
      subpath: params._splat,
      token: deps.token,
    }),
  staleTime: 10_000,
  component: ProjectContextRoute,
});

function ProjectContextRoute() {
  const { _splat } = Route.useParams();
  return <ContextRoutePage routeData={Route.useLoaderData()} subpath={_splat} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return { t: typeof search.t === "string" ? search.t : undefined };
}
