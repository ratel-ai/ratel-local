import { createFileRoute } from "@tanstack/react-router";
import { ChatDetailPage } from "@/pages/ChatDetailPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/chats/$id")({
  validateSearch,
  component: ChatDetailRoute,
});

function ChatDetailRoute() {
  const { id } = Route.useParams();
  return <ChatDetailPage sessionId={id} />;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
