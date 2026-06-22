import { createFileRoute } from "@tanstack/react-router";
import { ChatsPage } from "@/pages/ChatsPage";

type AppSearch = {
  t?: string;
};

export const Route = createFileRoute("/chats")({
  validateSearch,
  component: ChatsPage,
});

function validateSearch(search: Record<string, unknown>): AppSearch {
  return {
    t: typeof search.t === "string" ? search.t : undefined,
  };
}
