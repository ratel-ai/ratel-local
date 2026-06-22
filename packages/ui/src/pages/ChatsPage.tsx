import { useNavigate } from "@tanstack/react-router";
import { MessagesSquare, RefreshCw, SearchIcon, Sparkles, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { chatPath, useRatelApp } from "@/App";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
  PageHeaderTitle,
} from "@/components/page-header";
import { ResponsiveToolbar, ResponsiveToolbarButton } from "@/components/responsive-toolbar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PrismSweep } from "@/components/ui/prism-sweep";
import { type ChatSummary, deleteChat, fetchChats, fetchIntents, runIntents } from "@/lib/intents";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; chats: ChatSummary[] };

export function ChatsPage() {
  const { request, openCommandMenu } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Run status from the server, so a per-chat "Analyzing…" indicator survives
  // navigating away and back (the flag lives on the server, not in the button).
  const [run, setRun] = useState<{
    running: boolean;
    sessionId: string | null;
    queued: string[];
  }>({
    running: false,
    sessionId: null,
    queued: [],
  });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const { chats } = await fetchChats(request);
      setState({ status: "ready", chats });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load chats",
      });
    }
  }, [request]);

  // void-returning wrapper for child `onReload` props.
  const reload = useCallback(async () => {
    await load();
  }, [load]);

  // Refetch without the full-page "Loading…" flip, for the auto-refresh + button.
  const quietRefresh = useCallback(async () => {
    try {
      const { chats } = await fetchChats(request);
      setState({ status: "ready", chats });
    } catch {
      // keep whatever's on screen; the next refresh may succeed
    }
  }, [request]);

  // New conversations are captured by the plugin as you use your agent; pick them
  // up automatically so the list stays current without a manual reload.
  useEffect(() => {
    const id = window.setInterval(() => void quietRefresh(), 15000);
    return () => window.clearInterval(id);
  }, [quietRefresh]);

  const refreshRun = useCallback(async () => {
    try {
      const data = await fetchIntents(request);
      const queued = data.queuedSessionIds ?? [];
      setRun({
        running: data.running ?? false,
        sessionId: data.runningSessionId ?? null,
        queued,
      });
      // Keep polling while anything is still running OR waiting in the queue.
      return (data.running ?? false) || queued.length > 0;
    } catch {
      return false;
    }
  }, [request]);

  useEffect(() => {
    void load();
    void refreshRun();
  }, [load, refreshRun]);

  // While a run is in flight, poll its status; when it finishes, refresh the list
  // so the analyzed chat's intent count updates.
  const active = run.running || run.queued.length > 0;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      const stillActive = await refreshRun();
      if (!cancelled && !stillActive) await load();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, refreshRun, load]);

  const chats = state.status === "ready" ? state.chats : [];

  return (
    <main className="flex w-full flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Chats</PageHeaderTitle>
            <div className="flex items-center gap-1 sm:hidden">
              <Button
                aria-label="Search"
                onClick={openCommandMenu}
                size="icon-lg"
                type="button"
                variant="outline"
              >
                <SearchIcon />
                <span className="sr-only">Search</span>
              </Button>
              <PageHeaderSidebarTrigger />
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Recent conversations captured by the Ratel plugin. Open one to read its turns, or remove
            chats you no longer want analyzed — chats with no extracted intents are safe to clear.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden items-center sm:flex">
          <Button className="h-10" onClick={() => void quietRefresh()} size="sm" variant="outline">
            <RefreshCw />
            Refresh
          </Button>
          <ResponsiveToolbar>
            <ResponsiveToolbarButton
              icon={<SearchIcon />}
              kbd="⌘K"
              label="Search"
              onClick={openCommandMenu}
            />
          </ResponsiveToolbar>
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
        </PageHeaderActions>
      </PageHeader>

      {state.status === "loading" && (
        <p className="px-1 text-muted-foreground text-sm">Loading chats…</p>
      )}

      {state.status === "error" && (
        <EmptyState title="Couldn't load chats" description={state.message}>
          <Button onClick={() => void load()} size="sm" variant="outline">
            Retry
          </Button>
        </EmptyState>
      )}

      {state.status === "ready" && chats.length === 0 && (
        <EmptyState
          title="No captured chats yet."
          description="Once the Ratel plugin captures some chat from your agent, conversations show up here. Make sure the plugin hooks are trusted in your agent."
        />
      )}

      {state.status === "ready" && chats.length > 0 && (
        <>
          <span className="px-1 text-muted-foreground text-xs">
            {chats.length} chat{chats.length === 1 ? "" : "s"}
          </span>
          <ul className="grid gap-2">
            {chats.map((chat) => (
              <ChatRow
                chat={chat}
                key={chat.sessionId}
                onKicked={refreshRun}
                onReload={reload}
                processing={run.running && run.sessionId === chat.sessionId}
                queued={run.queued.includes(chat.sessionId)}
              />
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function ChatRow(props: {
  chat: ChatSummary;
  processing: boolean;
  queued: boolean;
  onKicked: () => Promise<boolean>;
  onReload: () => Promise<void>;
}) {
  const { chat } = props;
  const navigate = useNavigate();
  const { token } = useRatelApp();
  const safeToRemove = chat.intentCount === 0;
  return (
    <li className="flex items-start gap-3 rounded-md border border-border bg-card p-3">
      <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
      <div className="min-w-0 flex-1">
        <button
          className="block max-w-full truncate text-left font-medium hover:underline"
          onClick={() => void navigate({ to: chatPath(chat.sessionId, token) } as never)}
          type="button"
        >
          {chat.title}
        </button>
        <p className="mt-0.5 truncate text-muted-foreground text-xs">
          {chat.host} · {chat.sessionId}
          {chat.cwd ? ` · ${chat.cwd}` : ""}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
          <span>
            {chat.turnCount} turn{chat.turnCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <span>
            {chat.intentCount} intent{chat.intentCount === 1 ? "" : "s"} / {chat.gapCount} gap
            {chat.gapCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden>·</span>
          <AnalyzedBadge analyzed={chat.analyzed} />
          {chat.idle && (
            <>
              <span aria-hidden>·</span>
              <span>idle</span>
            </>
          )}
          {chat.updatedAt && (
            <>
              <span aria-hidden>·</span>
              <span>updated {relativeTime(chat.updatedAt)}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AnalyzeChatButton
          onKicked={props.onKicked}
          processing={props.processing}
          queued={props.queued}
          sessionId={chat.sessionId}
        />
        <DeleteChatButton
          onDeleted={props.onReload}
          safeToRemove={safeToRemove}
          sessionId={chat.sessionId}
          title={chat.title}
        />
      </div>
    </li>
  );
}

/**
 * Force-analyze just this chat (bypasses the cadence/recency due-checks). The
 * "Analyzing…" state is driven by the server's run status (`processing`), so it
 * persists across navigation — leaving and returning to Chats still shows it.
 */
function AnalyzeChatButton(props: {
  sessionId: string;
  processing: boolean;
  queued: boolean;
  onKicked: () => Promise<boolean>;
}) {
  const { request, runAction } = useRatelApp();

  const onClick = async () => {
    await runAction("Queued for analysis…", () => runIntents(request, props.sessionId));
    // Pick up the server's run status so the indicator (and polling) start now.
    await props.onKicked();
  };

  if (props.processing) {
    return (
      <div className="flex items-center gap-2 px-2 text-muted-foreground text-xs">
        <PrismSweep dotSize={3} size={20} speed={1.3} />
        Analyzing…
      </div>
    );
  }
  if (props.queued) {
    return <span className="px-2 text-muted-foreground text-xs">Queued…</span>;
  }
  return (
    <Button
      aria-label="Analyze intents for this chat"
      onClick={() => void onClick()}
      size="sm"
      variant="outline"
    >
      <Sparkles />
      Analyze intents
    </Button>
  );
}

function AnalyzedBadge(props: { analyzed: boolean }) {
  if (props.analyzed) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-emerald-500/70" />
        Analyzed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-1.5 rounded-full bg-muted-foreground/40" />
      Not analyzed
    </span>
  );
}

function DeleteChatButton(props: {
  sessionId: string;
  title: string;
  safeToRemove: boolean;
  onDeleted: () => Promise<void>;
}) {
  const { request, runAction, busy } = useRatelApp();
  const [open, setOpen] = useState(false);
  const remove = async () => {
    const ok = await runAction("Deleted chat", () => deleteChat(request, props.sessionId));
    if (ok) {
      setOpen(false);
      await props.onDeleted();
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button aria-label="Delete chat" size="icon-sm" variant="ghost" />}>
        <Trash2 />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this chat?</DialogTitle>
          <DialogDescription>
            Removes the captured conversation “{props.title}”. This can't be undone.
            {props.safeToRemove ? " No intents were extracted from it — safe to remove." : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button disabled={busy} onClick={() => void remove()} size="sm" variant="destructive">
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md gap-3">
        <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
          <MessagesSquare className="size-5" />
        </div>
        <div>
          <h3 className="font-medium">{props.title}</h3>
          <p className="mt-1 text-muted-foreground text-sm">{props.description}</p>
        </div>
        {props.children && <div>{props.children}</div>}
      </div>
    </section>
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
