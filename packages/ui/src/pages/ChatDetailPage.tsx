import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRatelApp } from "@/App";
import { Markdown } from "@/components/markdown";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
  PageHeaderTitle,
} from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { type ChatDetail, type ChatTurn, fetchChat } from "@/lib/intents";
import { cn } from "@/lib/utils";

/** Turns loaded on first open. */
const INITIAL_LIMIT = 40;
/** How many additional turns each "Load earlier" click reveals. */
const LOAD_STEP = 60;

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ChatDetail };

/** A run of consecutive turns that all share the same role. */
interface TurnGroup {
  role: ChatTurn["role"];
  turns: ChatTurn[];
}

/**
 * Collapse consecutive same-role turns into a single group so a long assistant
 * monologue renders as one block instead of a card per message. A role change
 * starts a new group.
 */
function groupTurns(turns: ChatTurn[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const turn of turns) {
    const last = groups[groups.length - 1];
    if (last && last.role === turn.role) {
      // Build a new group object rather than mutating the existing one.
      groups[groups.length - 1] = { role: last.role, turns: [...last.turns, turn] };
    } else {
      groups.push({ role: turn.role, turns: [turn] });
    }
  }
  return groups;
}

export function ChatDetailPage(props: { sessionId: string }) {
  const navigate = useNavigate();
  const { request, token } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  // Distinct from the full-page "loading" status so the transcript stays
  // visible while older turns are fetched in the background.
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const backPath = token ? `/chats?t=${encodeURIComponent(token)}` : "/chats";
  const goBack = () => {
    void navigate({ to: backPath } as never);
  };

  const load = useCallback(
    async (nextLimit: number, signal?: { cancelled: boolean }) => {
      try {
        const data = await fetchChat(request, props.sessionId, nextLimit);
        if (!signal?.cancelled) setState({ status: "ready", data });
      } catch (err) {
        if (!signal?.cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load conversation",
          });
        }
      }
    },
    [request, props.sessionId],
  );

  // Initial load (and reload when the session changes). Cancel a superseded
  // load so a stale response can't clobber a newer one.
  useEffect(() => {
    const signal = { cancelled: false };
    setState({ status: "loading" });
    setLimit(INITIAL_LIMIT);
    void load(INITIAL_LIMIT, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const detail = state.status === "ready" ? state.data : null;

  const loadEarlier = useCallback(async () => {
    if (!detail) return;
    const nextLimit = Math.min(limit + LOAD_STEP, detail.total);
    setLimit(nextLimit);
    setLoadingEarlier(true);
    await load(nextLimit);
    setLoadingEarlier(false);
  }, [detail, limit, load]);

  const retry = () => {
    setState({ status: "loading" });
    void load(limit);
  };

  const hasMore = detail ? detail.turns.length < detail.total : false;
  const olderCount = detail ? detail.total - detail.turns.length : 0;
  const groups = detail ? groupTurns(detail.turns) : [];

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Chats
            </Button>
            <div className="flex items-center gap-1 sm:hidden">
              <PageHeaderSidebarTrigger />
            </div>
          </PageHeaderBackRow>
          <PageHeaderTitle className="mt-4 truncate text-2xl">
            {detail?.title ?? props.sessionId}
          </PageHeaderTitle>
          <PageHeaderDescription className="mt-2 truncate">
            {detail ? (
              <>
                {detail.host} · <span className="font-mono">{detail.sessionId}</span>
                {detail.cwd ? ` · ${detail.cwd}` : ""}
              </>
            ) : (
              props.sessionId
            )}
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden sm:flex">
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
        </PageHeaderActions>
      </PageHeader>

      {state.status === "loading" && (
        <p className="px-1 text-muted-foreground text-sm">Loading conversation…</p>
      )}

      {state.status === "error" && (
        <div className="grid gap-3">
          <p className="text-destructive text-sm">{state.message}</p>
          <div>
            <Button onClick={retry} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        </div>
      )}

      {detail && detail.turns.length === 0 && (
        <p className="px-1 text-muted-foreground text-sm">No turns in this conversation.</p>
      )}

      {detail && detail.turns.length > 0 && (
        <div className="grid max-w-3xl gap-4">
          <p className="px-1 text-muted-foreground text-xs">
            Showing last {detail.turns.length} of {detail.total} turn
            {detail.total === 1 ? "" : "s"}
          </p>

          {hasMore && (
            <div className="flex justify-center">
              <Button
                disabled={loadingEarlier}
                onClick={() => void loadEarlier()}
                size="sm"
                type="button"
                variant="outline"
              >
                {loadingEarlier ? <Loader2 className="animate-spin" /> : <ChevronUp />}
                Load earlier ({olderCount} older)
              </Button>
            </div>
          )}

          <div className="grid gap-4">
            {groups.map((group, index) => (
              <TurnGroupBlock
                group={group}
                // Groups derive from an ordered, append-only transcript and
                // never reorder, so the index is a safe, stable key.
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered, append-only transcript
                key={index}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

function TurnGroupBlock(props: { group: TurnGroup }) {
  const isUser = props.group.role === "user";
  // Show the timestamp of the latest message in the group, if any.
  const lastTs = [...props.group.turns].reverse().find((t) => t.ts)?.ts;

  return (
    <div
      className={cn(
        "rounded-md border bg-card",
        isUser
          ? "border-sky-500/30 border-l-2 border-l-sky-500 bg-sky-500/5 sm:ml-8"
          : "border-border border-l-2 border-l-brand-green sm:mr-8",
      )}
    >
      <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2 text-xs">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 font-medium",
            isUser ? "text-sky-600 dark:text-sky-400" : "text-brand-green",
          )}
        >
          <span className={cn("size-1.5 rounded-full", isUser ? "bg-sky-500" : "bg-brand-green")} />
          {isUser ? "User" : "Assistant"}
        </span>
        {props.group.turns.length > 1 && (
          <span className="text-muted-foreground">{props.group.turns.length} messages</span>
        )}
        {lastTs && <span className="ml-auto text-muted-foreground">{relativeTime(lastTs)}</span>}
      </div>
      <div className="grid gap-3 p-3">
        {props.group.turns.map((turn, index) => (
          <div
            className={cn(
              // Separate stacked messages within a group with a hairline.
              index > 0 && "border-border/40 border-t pt-3",
            )}
            // Stacked messages share the group's role and order; index is stable here.
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered, append-only transcript
            key={index}
          >
            <Markdown>{turn.content || "_(empty)_"}</Markdown>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" / a date for older timestamps. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}
