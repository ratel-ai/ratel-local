import { createRootRoute } from "@tanstack/react-router";
import { AppShell } from "@/App";

export const Route = createRootRoute({
  component: RootRoute,
});

function RootRoute() {
  return <AppShell />;
}
