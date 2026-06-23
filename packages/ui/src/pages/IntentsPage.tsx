import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cog,
  Eye,
  EyeOff,
  MessagesSquare,
  Play,
  RefreshCw,
  SearchIcon,
  Sparkles,
  Target,
  Trash2,
  XCircle,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { chatPath, skillPath, useRatelApp } from "@/App";
import {
  IntentSearchingRow,
  PLACEHOLDER_EXIT_MS,
  usePresence,
  useStreamingOrder,
} from "@/components/intent-stream";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PixelProgress } from "@/components/ui/pixel-progress";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PrismSweep } from "@/components/ui/prism-sweep";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  type AnalysisSettings,
  type Cadence,
  clearIntents,
  clearOfferJob,
  deleteIntent,
  type ExtractorHealth,
  estimateGenMs,
  fetchAnalysisSettings,
  fetchChats,
  fetchIntents,
  type IntentRecord,
  type IntentsIndex,
  listOfferJobs,
  type OfferJobSummary,
  offerSkill,
  offerSkillStatus,
  runAllIntents,
  runIntents,
  type SessionSummary,
  type SkillDraft,
  saveAnalysisSettings,
  skillGenModelOptions,
  testExtractor,
} from "@/lib/intents";
import { cn } from "@/lib/utils";
import { ObservabilityPanel } from "@/pages/ObservabilityPage";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: IntentsIndex };

type View = "cumulative" | "by-session" | "observability";

/** sessionId → its chat title/host, for the "seen in N sessions" links. */
type SessionTitles = Record<string, { title: string; host?: string }>;
/** intent content → its live authoring job, so a result survives navigation. */
type OfferJobs = Record<string, OfferJobSummary>;

export function IntentsPage() {
  const { request, runAction, busy, openCommandMenu } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [view, setView] = useState<View>("cumulative");
  const [running, setRunning] = useState(false);
  const [sessionTitles, setSessionTitles] = useState<SessionTitles>({});
  const [offerJobs, setOfferJobs] = useState<OfferJobs>({});

  const load = useCallback(async () => {
    try {
      const data = await fetchIntents(request);
      setState({ status: "ready", data });
      return data;
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load intents",
      });
      return null;
    }
  }, [request]);

  // Side data: chat titles (for the "seen in N sessions" links) and any in-flight
  // or finished authoring jobs (so a result stays reachable after navigating away).
  const loadAux = useCallback(async () => {
    try {
      const [{ chats }, { jobs }] = await Promise.all([
        fetchChats(request),
        listOfferJobs(request),
      ]);
      const titles: SessionTitles = {};
      for (const c of chats) titles[c.sessionId] = { title: c.title, host: c.host };
      setSessionTitles(titles);
      const byIntent: OfferJobs = {};
      for (const j of jobs) byIntent[j.intent] = j;
      setOfferJobs(byIntent);
    } catch {
      // Non-fatal: the page still works without titles/job hydration.
    }
  }, [request]);

  // void-returning wrapper for child `onReload`/`onCleared` props.
  const reload = useCallback(async () => {
    await Promise.all([load(), loadAux()]);
  }, [load, loadAux]);

  useEffect(() => {
    void load();
    void loadAux();
  }, [load, loadAux]);

  const ready = state.status === "ready" ? state.data : null;
  const intents = ready?.intents ?? [];
  const sessions = ready?.sessions ?? [];
  const cadence = ready?.cadence;
  const analysisOff = ready?.enabled === false;
  // A run may be in flight even if this client didn't start it (per-chat analyze,
  // the cadence scheduler, another tab). Reflect the server's flag too.
  const serverRunning = ready?.running === true;
  const showRunning = running || serverRunning;

  // The run is fire-and-forget on the server; poll while it (or any other trigger)
  // reports `running` so results stream in and the banner clears itself.
  useEffect(() => {
    if (!running && !serverRunning) return;
    let cancelled = false;
    const tick = async () => {
      const data = await load();
      if (cancelled) return;
      // A failed poll returns null (e.g. an expired token after the server
      // restarted). Stop the spinner so the error state surfaces with a Retry,
      // rather than hanging on "Analyzing…" forever with no feedback.
      if (!data?.running) setRunning(false);
    };
    const id = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [running, serverRunning, load]);

  const runNow = useCallback(
    async (all = false) => {
      // Show the banner immediately so there's feedback even if the backend runs
      // synchronously (e.g. a stale dev server that hasn't picked up fire-and-forget).
      setRunning(true);
      const ok = await runAction(all ? "Re-analyzing all chats" : "Analysis started", () =>
        all ? runAllIntents(request) : runIntents(request),
      );
      const data = await load();
      // Keep the banner only while the server reports an in-flight run; the polling
      // effect clears it when that finishes. Otherwise (error, or a synchronous
      // backend with no `running` flag) clear it now - the results are already in.
      if (!ok || !data?.running) setRunning(false);
    },
    [runAction, request, load],
  );

  return (
    <main className="flex w-full flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Intents</PageHeaderTitle>
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
            What you keep asking your agents to do, extracted from captured chat and matched against
            the skills Ratel manages. Gaps are intents no skill covers - offer a new skill to close
            them.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden items-center sm:flex">
          <AnalysisSettingsDialog />
          <Button
            className="h-10"
            disabled={busy || showRunning || analysisOff}
            onClick={() => void runNow(true)}
            size="sm"
            title="Re-analyze every chat from scratch (ignores cache and the new-activity filter)"
            variant="outline"
          >
            <RefreshCw />
            Re-analyze all
          </Button>
          <Button
            className="h-10"
            disabled={busy || showRunning || analysisOff}
            onClick={() => void runNow()}
            size="sm"
            title="Analyze every chat (reuses cached results for unchanged chats)"
          >
            {showRunning ? <Spinner /> : <Play />}
            {showRunning ? "Analyzing…" : "Run now"}
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
        <p className="px-1 text-muted-foreground text-sm">Loading intents…</p>
      )}

      {state.status === "error" && (
        <EmptyState title="Couldn't load intents" description={state.message}>
          <Button onClick={() => void load()} size="sm" variant="outline">
            Retry
          </Button>
        </EmptyState>
      )}

      {analysisOff && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          Analysis is off - chat isn't being captured and runs are disabled. Turn it on in{" "}
          <strong className="font-medium">Settings → Enabled</strong>.
        </div>
      )}

      {/* No "analyzing" banner while results are on screen — the searching slot at the
          top of the list (and the Run-now button's spinner) already signal the run. */}

      {!showRunning && ready?.lastError && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200">
          Last analysis didn't finish: {ready.lastError}
        </div>
      )}

      {ready && (
        <>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {/* The two intent views are a segmented control; "Run history" is a
                  separate, visually distinct thing (analysis telemetry), set apart
                  by a divider so it doesn't read as a third view of the same data. */}
              <Tabs
                onValueChange={(v) => setView(v as View)}
                value={view === "observability" ? "" : view}
              >
                <TabsList>
                  <TabsTrigger value="cumulative">Cumulative</TabsTrigger>
                  <TabsTrigger value="by-session">By session</TabsTrigger>
                </TabsList>
              </Tabs>
              <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />
              <Button
                className={
                  view === "observability" ? "bg-accent text-foreground" : "text-muted-foreground"
                }
                onClick={() => setView(view === "observability" ? "cumulative" : "observability")}
                size="sm"
                variant="ghost"
              >
                <Activity />
                Run history
              </Button>
            </div>
            {view !== "observability" && intents.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="px-1 text-muted-foreground text-xs">
                  {intents.length} intent{intents.length === 1 ? "" : "s"} ·{" "}
                  {intents.filter((i) => i.coverage.status === "gap").length} gaps
                  {cadence ? ` · due for analysis every ${cadence.everyNMessages} messages` : ""}
                </span>
                <ClearAllButton onCleared={reload} />
              </div>
            )}
          </div>

          {view === "observability" ? (
            <ObservabilityPanel />
          ) : intents.length === 0 ? (
            showRunning ? (
              <AnalyzingState />
            ) : (
              <EmptyState
                title="No intents yet"
                description="Once the plugin captures some chat, run an analysis to extract what you've been trying to do. Make sure the Ratel plugin hooks are trusted in your agent."
              >
                <Button disabled={busy} onClick={() => void runNow()} size="sm">
                  <Play />
                  Run analysis
                </Button>
              </EmptyState>
            )
          ) : view === "cumulative" ? (
            <IntentList
              intents={intents}
              jobs={offerJobs}
              onReload={reload}
              sessionTitles={sessionTitles}
              streaming={showRunning}
            />
          ) : (
            <BySessionView
              cadence={cadence}
              intents={intents}
              jobs={offerJobs}
              onReload={reload}
              sessions={sessions}
              sessionTitles={sessionTitles}
            />
          )}
        </>
      )}
    </main>
  );
}

const SESSIONS_PAGE = 8;

function BySessionView(props: {
  intents: IntentRecord[];
  sessions: SessionSummary[];
  cadence?: Cadence;
  sessionTitles: SessionTitles;
  jobs: OfferJobs;
  onReload: () => Promise<void>;
}) {
  const [shown, setShown] = useState(SESSIONS_PAGE);
  // Hide sessions that produced no intents (nothing to show) and sort newest first.
  const sessions = [...props.sessions]
    .filter((s) => s.intentCount > 0)
    .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
  if (sessions.length === 0) {
    return (
      <p className="px-1 text-muted-foreground text-sm">No analyzed sessions with intents yet.</p>
    );
  }
  const visible = sessions.slice(0, shown);
  const remaining = sessions.length - visible.length;
  return (
    <div className="grid gap-5">
      {visible.map((session) => {
        const intents = props.intents.filter((i) => i.sessions.includes(session.sessionId));
        return (
          <section className="grid gap-2" key={session.sessionId}>
            <div className="px-1">
              <h2 className="truncate font-medium text-sm">
                {session.cwd ?? session.sessionId}{" "}
                <span className="text-muted-foreground">
                  ({session.intentCount} intent{session.intentCount === 1 ? "" : "s"},{" "}
                  {session.gapCount} gaps)
                </span>
              </h2>
              <p className="truncate text-muted-foreground text-xs">
                {session.host ?? "unknown"} · {session.sessionId}
                {cadenceProgress(session, props.cadence)}
              </p>
            </div>
            <IntentList
              intents={intents}
              jobs={props.jobs}
              onReload={props.onReload}
              sessionTitles={props.sessionTitles}
            />
          </section>
        );
      })}
      {remaining > 0 && (
        <div className="flex justify-center">
          <Button onClick={() => setShown((n) => n + SESSIONS_PAGE)} size="sm" variant="outline">
            Show more sessions ({remaining} more)
          </Button>
        </div>
      )}
    </div>
  );
}

/** " · 3/10 new messages since last analysis" when a session has accumulated turns. */
function cadenceProgress(session: SessionSummary, cadence?: Cadence): string {
  const newTurns = session.newTurnCount ?? 0;
  if (!cadence || newTurns === 0) return "";
  const remaining = Math.max(0, cadence.everyNMessages - newTurns);
  const tail = remaining === 0 ? "due now" : `${remaining} until due`;
  return ` · ${newTurns}/${cadence.everyNMessages} new since last analysis (${tail})`;
}

const INTENTS_PAGE = 25;

function IntentList(props: {
  intents: IntentRecord[];
  sessionTitles: SessionTitles;
  jobs: OfferJobs;
  onReload: () => Promise<void>;
  /** A run is streaming results into this list: animate new rows in and show the slot. */
  streaming?: boolean;
}) {
  const streaming = props.streaming ?? false;
  const { items, entering } = useStreamingOrder(props.intents, streaming);
  const [shown, setShown] = useState(INTENTS_PAGE);
  // Keep the searching slot mounted through its collapse animation after a run ends.
  const placeholder = usePresence(streaming, PLACEHOLDER_EXIT_MS);

  // New intents arrive at the TOP, so they're always within the first page — no need
  // to reveal the whole list; older intents stay paginated.
  const visible = items.slice(0, shown);
  const remaining = items.length - visible.length;
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {/* The searching slot sits at the top; each new intent grows in just below it,
            pushing the rest down — results stream in from the top. */}
        {placeholder.mounted && <IntentSearchingRow exiting={placeholder.exiting} />}
        {visible.map((intent) => (
          <li
            // The wrapper li grows the row into place on arrival; the inner overflow
            // clip is what makes the height animation read as a slide down from the top.
            className={cn("grid", entering.has(intent.content) && "animate-intent-enter")}
            key={intent.content}
          >
            <div className="overflow-hidden">
              <IntentRow
                initialJob={props.jobs[intent.content]}
                intent={intent}
                onReload={props.onReload}
                sessionTitles={props.sessionTitles}
              />
            </div>
          </li>
        ))}
      </ul>
      {remaining > 0 && (
        <div className="flex justify-center pt-1">
          <Button onClick={() => setShown((n) => n + INTENTS_PAGE)} size="sm" variant="outline">
            Show more ({remaining} more)
          </Button>
        </div>
      )}
    </div>
  );
}

function IntentRow(props: {
  intent: IntentRecord;
  sessionTitles: SessionTitles;
  initialJob?: OfferJobSummary;
  onReload: () => Promise<void>;
}) {
  const { intent } = props;
  const seen = intent.sessions.length;
  const isGap = intent.coverage.status === "gap";
  // The server already ranks the list; a gap that recurs across several sessions
  // is what we want users to act on first, so flag it as a top gap.
  const topGap = isGap && seen >= 3;
  // Emphasize frequency when an intent shows up across many sessions.
  const frequent = seen >= 3;
  return (
    <div className="flex items-start gap-3 rounded-md border border-border bg-card p-3">
      <Target className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <strong className="font-medium">{intent.content}</strong>
          {topGap && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-medium text-[10px] text-amber-700 uppercase tracking-wide dark:text-amber-300">
              Top gap
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
          <CoverageBadge intent={intent} />
          <span aria-hidden>·</span>
          <SessionsPopover
            frequent={frequent}
            sessionIds={intent.sessions}
            sessionTitles={props.sessionTitles}
          />
          {intent.evidences && intent.evidences.length > 0 && (
            <>
              <span aria-hidden>·</span>
              <EvidenceDisclosure evidences={intent.evidences} />
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Offer a skill for any intent - covered ones can still want a better/new skill;
            the generator already gets existing skill IDs so it won't duplicate. */}
        <OfferSkillCell
          initialJob={props.initialJob}
          intent={intent.content}
          onCreated={props.onReload}
        />
        <DeleteIntentButton content={intent.content} onDeleted={props.onReload} />
      </div>
    </div>
  );
}

/** "seen in N sessions" - opens the list of those chats (capped), each a link to its page. */
function SessionsPopover(props: {
  sessionIds: string[];
  sessionTitles: SessionTitles;
  frequent: boolean;
}) {
  const { token } = useRatelApp();
  const navigate = useNavigate();
  const seen = props.sessionIds.length;
  const CAP = 10;
  const shown = props.sessionIds.slice(0, CAP);
  const more = seen - shown.length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className={
              props.frequent
                ? "inline-flex items-center gap-1 font-semibold text-foreground hover:underline"
                : "inline-flex items-center gap-1 hover:text-foreground hover:underline"
            }
            type="button"
          />
        }
      >
        <MessagesSquare className="size-3" />
        seen in {seen} session{seen === 1 ? "" : "s"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-1 p-1">
        <p className="px-2 pt-1 text-muted-foreground text-xs">Open a chat</p>
        <div className="grid">
          {shown.map((sid) => {
            const meta = props.sessionTitles[sid];
            return (
              <button
                className="grid gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent"
                key={sid}
                onClick={() => void navigate({ to: chatPath(sid, token) } as never)}
                type="button"
              >
                <span className="truncate text-xs">{meta?.title ?? sid}</span>
                <span className="truncate font-mono text-[10px] text-muted-foreground">{sid}</span>
              </button>
            );
          })}
        </div>
        {more > 0 && (
          <p className="px-2 py-1 text-[10px] text-muted-foreground">
            +{more} more session{more === 1 ? "" : "s"}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Expandable "proof" for an intent: the evidence spans/turns that produced it. */
function EvidenceDisclosure(props: { evidences: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {open ? "Hide" : "Show"} evidence ({props.evidences.length})
      </button>
      {open && (
        <ul className="mt-1 grid basis-full gap-1.5 border-muted-foreground/20 border-l-2 pl-3">
          {props.evidences.map((ev, i) => (
            <li
              className="whitespace-pre-wrap text-muted-foreground italic"
              // Evidence is a static, read-only list that never reorders, so the index is a safe key.
              // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered evidence list
              key={i}
            >
              “{ev}”
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function DeleteIntentButton(props: { content: string; onDeleted: () => Promise<void> }) {
  const { request, runAction, busy } = useRatelApp();
  const onClick = async () => {
    const ok = await runAction("Deleted intent", () => deleteIntent(request, props.content));
    if (ok) await props.onDeleted();
  };
  return (
    <Button
      aria-label="Delete intent"
      disabled={busy}
      onClick={() => void onClick()}
      size="icon-sm"
      variant="ghost"
    >
      <Trash2 />
    </Button>
  );
}

function ClearAllButton(props: { onCleared: () => Promise<void> }) {
  const { request, runAction, busy } = useRatelApp();
  const [open, setOpen] = useState(false);
  const clear = async () => {
    const ok = await runAction("Cleared all intents", () => clearIntents(request));
    if (ok) {
      setOpen(false);
      await props.onCleared();
    }
  };
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Trash2 />
        Clear all
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear all intents?</DialogTitle>
          <DialogDescription>
            Removes every extracted intent from the list. They're re-extracted from captured chat
            the next time you run an analysis.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button disabled={busy} onClick={() => void clear()} size="sm" variant="destructive">
            Clear all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoverageBadge(props: { intent: IntentRecord }) {
  const { token } = useRatelApp();
  const navigate = useNavigate();
  const { coverage } = props.intent;

  if (coverage.status === "gap") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-1.5 rounded-full bg-amber-500/60" />
        Gap
      </span>
    );
  }

  // Quiet metadata-weight indicator; click to reveal the BM25-ranked skills as links.
  const count = coverage.skills.length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            className="inline-flex items-center gap-1.5 hover:text-foreground hover:underline"
            type="button"
          />
        }
      >
        <span className="size-1.5 rounded-full bg-emerald-500/70" />
        Covered ({count})
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-1 p-1">
        <p className="px-2 pt-1 text-muted-foreground text-xs">Matching skills (BM25)</p>
        <div className="grid">
          {coverage.skills.map((skill) => (
            <button
              className="flex items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
              key={skill.skillId}
              onClick={() => void navigate({ to: skillPath(skill.skillId, token) } as never)}
              type="button"
            >
              <span className="truncate font-mono text-xs">{skill.skillId}</span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {skill.score.toFixed(1)}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type OfferPhase = "idle" | "running" | "ready" | "error";

const OFFER_POLL_MS = 1500;
const PROGRESS_CAP = 92;

/**
 * In-row "Offer New Skills" cell. Default state shows the button; on click it
 * starts a BACKGROUND authoring job and replaces the button in place with a
 * compact progress bar paced by the chosen model. When the job finishes it opens
 * the review dialog pre-filled with the draft.
 *
 * The job lives on the server, so it survives navigation: `initialJob` hydrates
 * this cell from the server's job registry - a still-running job resumes its
 * progress bar, and a finished one shows a "Review skill" button that reopens the
 * draft. That's what keeps a result reachable after you leave and come back.
 */
function OfferSkillCell(props: {
  intent: string;
  initialJob?: OfferJobSummary;
  onCreated: () => Promise<void>;
}) {
  const { request, runAction } = useRatelApp();
  const [phase, setPhase] = useState<OfferPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  // Expected authoring time (ms) for the chosen model, set from the start response.
  const [tau, setTau] = useState(() => estimateGenMs(props.initialJob?.model));
  // Set once a skill is created from this cell, so we don't re-hydrate it back to
  // "Review" from the (still-present) server job after the user is done with it.
  const consumed = useRef(false);

  // Adopt a pre-existing server job (started earlier / in another tab). Only from
  // the idle state, so it never clobbers an interaction already in progress.
  useEffect(() => {
    const job = props.initialJob;
    if (!job || consumed.current) return;
    setPhase((cur) => {
      if (cur !== "idle") return cur;
      if (job.status === "running") {
        setTau(estimateGenMs(job.model));
        return "running";
      }
      if (job.status === "done") return "ready";
      if (job.status === "error") {
        setError(job.error ?? "Failed to author a skill draft");
        return "error";
      }
      return cur;
    });
  }, [props.initialJob]);

  // Easing animation while the job runs: fast start, slowing exponentially and
  // hovering at the cap (~90–92%) until the result arrives. Paced by the model.
  useEffect(() => {
    if (phase !== "running") return;
    const start = performance.now();
    const id = window.setInterval(() => {
      const elapsed = performance.now() - start;
      setProgress(PROGRESS_CAP * (1 - Math.exp(-elapsed / tau)));
    }, 150);
    return () => window.clearInterval(id);
  }, [phase, tau]);

  // Poll the background job's status while it runs.
  useEffect(() => {
    if (phase !== "running") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await offerSkillStatus(request, props.intent);
        if (cancelled) return;
        if (status.model) setTau(estimateGenMs(status.model));
        if (status.status === "done" && status.draft) {
          setDraft(status.draft);
          // Snap to 100% briefly, then open the review dialog.
          setProgress(100);
          window.setTimeout(() => {
            if (cancelled) return;
            setPhase("ready");
            setReviewOpen(true);
          }, 400);
        } else if (status.status === "error") {
          setError(status.error ?? "Failed to author a skill draft");
          setPhase("error");
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to check authoring status");
        setPhase("error");
      }
    };
    const id = window.setInterval(() => void tick(), OFFER_POLL_MS);
    // Kick once immediately so a fast/cached job surfaces without a full interval.
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, request, props.intent]);

  const start = useCallback(async () => {
    setError("");
    setDraft(null);
    setProgress(0);
    consumed.current = false;
    try {
      const res = await offerSkill(request, props.intent);
      setTau(estimateGenMs(res.model));
      // Whether we started it or it was already running (another tab), begin polling.
      setPhase("running");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start skill authoring");
      setPhase("error");
    }
  }, [request, props.intent]);

  // Reopen a finished job's draft, fetching it first if this cell was hydrated
  // from the server (so it has the job but not yet the draft).
  const review = useCallback(async () => {
    if (draft) {
      setReviewOpen(true);
      return;
    }
    setLoadingDraft(true);
    try {
      const status = await offerSkillStatus(request, props.intent);
      if (status.draft) {
        setDraft(status.draft);
        setReviewOpen(true);
      } else if (status.status === "error") {
        setError(status.error ?? "Failed to author a skill draft");
        setPhase("error");
      } else {
        await start();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the draft");
      setPhase("error");
    } finally {
      setLoadingDraft(false);
    }
  }, [draft, request, props.intent, start]);

  const create = useCallback(
    async (edited: SkillDraft) => {
      const name = edited.name.trim();
      const ok = await runAction(`Created skill ${name}`, () =>
        request("/api/skills", {
          method: "POST",
          body: {
            name,
            description: edited.description.trim(),
            tags: edited.tags ?? [],
            body: edited.body,
          },
        }),
      );
      if (ok) {
        consumed.current = true;
        // Drop the server-side job too, so a later refresh doesn't re-surface this
        // (now-created) skill as "ready" and then fail with "already exists".
        await clearOfferJob(request, props.intent).catch(() => undefined);
        setReviewOpen(false);
        setPhase("idle");
        setDraft(null);
        await props.onCreated();
      }
      return ok;
    },
    [request, runAction, props.intent, props.onCreated],
  );

  // Discard the draft entirely: clear the server job so the notification goes away.
  const decline = useCallback(async () => {
    consumed.current = true;
    await clearOfferJob(request, props.intent).catch(() => undefined);
    setReviewOpen(false);
    setPhase("idle");
    setDraft(null);
    await props.onCreated();
  }, [request, props.intent, props.onCreated]);

  if (phase === "running") {
    return (
      <div className="flex w-44 items-center gap-2">
        <PixelProgress className="flex-1" progress={progress} />
        <span className="shrink-0 text-muted-foreground text-xs">Authoring…</span>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="max-w-32 truncate text-destructive text-xs" title={error}>
          {error}
        </span>
        <Button onClick={() => void start()} size="sm" variant="outline">
          Retry
        </Button>
      </div>
    );
  }

  return (
    <>
      {phase === "ready" ? (
        <Button
          className="bg-brand-green text-white shadow-brand-green/20 shadow-sm hover:bg-brand-green/90"
          disabled={loadingDraft}
          onClick={() => void review()}
          size="sm"
        >
          {loadingDraft ? (
            <Spinner />
          ) : (
            <span className="size-1.5 rounded-full bg-white/90 motion-safe:animate-pulse" />
          )}
          Skill ready - review
        </Button>
      ) : (
        <Button onClick={() => void start()} size="sm" variant="outline">
          <Sparkles />
          Offer New Skills
        </Button>
      )}
      {draft && (
        <OfferSkillReviewDialog
          draft={draft}
          intent={props.intent}
          onCreate={create}
          onDecline={decline}
          onOpenChange={setReviewOpen}
          open={reviewOpen}
        />
      )}
    </>
  );
}

/** Controlled review/edit dialog for a finished skill draft. */
function OfferSkillReviewDialog(props: {
  intent: string;
  draft: SkillDraft;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onCreate: (edited: SkillDraft) => Promise<boolean>;
  onDecline: () => Promise<void>;
}) {
  const { busy } = useRatelApp();
  const { draft } = props;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [tags, setTags] = useState((draft.tags ?? []).join(", "));
  const [body, setBody] = useState(draft.body);

  // Re-seed the fields whenever a fresh draft is handed in.
  useEffect(() => {
    setName(draft.name);
    setDescription(draft.description);
    setTags((draft.tags ?? []).join(", "));
    setBody(draft.body);
    setEditing(false);
  }, [draft]);

  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const create = async () => {
    await props.onCreate({
      name: name.trim(),
      description: description.trim(),
      tags: tagList,
      body,
    });
  };

  return (
    <Dialog onOpenChange={props.onOpenChange} open={props.open}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Offer a new skill</DialogTitle>
          <DialogDescription className="line-clamp-2">
            Drafted for “{props.intent}”. Review, optionally edit, then save - it writes a SKILL.md
            into Ratel's managed folder.
          </DialogDescription>
        </DialogHeader>

        {/* Only this middle region scrolls; header + footer stay put. */}
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {!editing && (
            <div className="grid gap-3">
              <div>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{name}</code>
                <p className="mt-1.5 font-medium text-sm">{description}</p>
              </div>
              {tagList.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {tagList.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="rounded-md border border-border bg-card p-3">
                <Markdown>{body || "_(no instructions)_"}</Markdown>
              </div>
            </div>
          )}

          {editing && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="offer-name">Name</Label>
                <Input id="offer-name" onChange={(e) => setName(e.target.value)} value={name} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="offer-description">Description</Label>
                <Textarea
                  id="offer-description"
                  onChange={(e) => setDescription(e.target.value)}
                  value={description}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="offer-tags">Tags (comma-separated)</Label>
                <Input id="offer-tags" onChange={(e) => setTags(e.target.value)} value={tags} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="offer-body">Instructions</Label>
                <Textarea
                  className="min-h-48 font-mono text-xs"
                  id="offer-body"
                  onChange={(e) => setBody(e.target.value)}
                  value={body}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void props.onDecline()}
            size="sm"
            variant="ghost"
          >
            <Trash2 />
            Decline
          </Button>
          <div className="flex items-center gap-2">
            <DialogClose render={<Button size="sm" variant="outline" />}>Later</DialogClose>
            <Button onClick={() => setEditing((e) => !e)} size="sm" variant="outline">
              {editing ? "Preview" : "Edit"}
            </Button>
            <Button disabled={busy || name.trim() === ""} onClick={() => void create()} size="sm">
              Create skill
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// base-ui Select can't hold an empty-string value, so the "Default" choice uses
// this sentinel and maps back to "" (which the generator treats as its default).
const SKILLGEN_DEFAULT = "__default__";

function AnalysisSettingsDialog() {
  const { request, runAction, busy } = useRatelApp();
  const [open, setOpen] = useState(false);
  const [secretMask, setSecretMask] = useState("");
  const [form, setForm] = useState<AnalysisSettings>({});
  // Numeric fields are kept as raw strings so partial input (e.g. "1.") types cleanly.
  const [nums, setNums] = useState<Record<string, string>>({});

  // Connection-test state for the extractor endpoint (the "Test connection" button).
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ExtractorHealth | null>(null);

  // Secrets are never sent to the browser — the server returns a mask sentinel.
  // We blank those fields (so the native reveal can't expose the sentinel) and
  // remember which were saved, re-injecting the sentinel on submit for a field the
  // user left untouched so a no-op save preserves the stored secret.
  const [savedSecrets, setSavedSecrets] = useState({ extractor: false, skillGen: false });
  const [secretTouched, setSecretTouched] = useState({ extractor: false, skillGen: false });

  const update = (patch: AnalysisSettings) => setForm((prev) => ({ ...prev, ...patch }));
  const setNum = (key: string, value: string) => setNums((n) => ({ ...n, [key]: value }));

  // Editing the extractor invalidates any prior test result (it may now be stale).
  const updateExtractor = (patch: Partial<NonNullable<AnalysisSettings["extractor"]>>) => {
    setTestResult(null);
    setForm((prev) => ({ ...prev, extractor: { ...prev.extractor, ...patch } }));
  };

  // Re-inject the mask sentinel for a saved secret the user didn't touch, so a
  // no-op save/test preserves the stored value (the server swaps the sentinel back
  // for the real secret). A touched-but-blank field is left blank → clears it.
  const withPreservedSecrets = (f: AnalysisSettings): AnalysisSettings => {
    const out: AnalysisSettings = { ...f };
    if (savedSecrets.extractor && !secretTouched.extractor && !f.extractor?.apiKey) {
      out.extractor = { ...f.extractor, apiKey: secretMask };
    }
    if (savedSecrets.skillGen && !secretTouched.skillGen && !f.skillGen?.apiKey) {
      out.skillGen = { ...f.skillGen, apiKey: secretMask };
    }
    return out;
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testExtractor(request, withPreservedSecrets(form).extractor));
    } catch (err) {
      setTestResult({ ok: false, detail: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setTesting(false);
    }
  };

  const onOpenChange = async (next: boolean) => {
    setOpen(next);
    setTestResult(null);
    setSecretTouched({ extractor: false, skillGen: false });
    if (next) {
      try {
        const res = await fetchAnalysisSettings(request);
        const a = res.analysis ?? {};
        // A saved secret arrives as the mask sentinel; blank the field but remember
        // it's saved (shown via a "saved" placeholder), so the reveal button can't
        // expose the sentinel and a no-op save still preserves the real value.
        const exSaved = Boolean(a.extractor) && a.extractor?.apiKey === res.secretMask;
        const sgSaved = Boolean(a.skillGen) && a.skillGen?.apiKey === res.secretMask;
        setForm({
          ...a,
          ...(a.extractor && {
            extractor: { ...a.extractor, apiKey: exSaved ? "" : a.extractor.apiKey },
          }),
          ...(a.skillGen && {
            skillGen: { ...a.skillGen, apiKey: sgSaved ? "" : a.skillGen.apiKey },
          }),
        });
        setSecretMask(res.secretMask);
        setSavedSecrets({ extractor: exSaved, skillGen: sgSaved });
        setNums({
          everyNMessages: numToStr(a.cadence?.everyNMessages),
          recentHours: numToStr(a.cadence?.recentHours),
          minScore: numToStr(a.coverage?.minScore),
          relativeRatio: numToStr(a.coverage?.relativeRatio),
          maxSkills: numToStr(a.coverage?.maxSkills),
        });
      } catch {
        setForm({});
        setSavedSecrets({ extractor: false, skillGen: false });
      }
    }
  };

  const save = async () => {
    const next: AnalysisSettings = withPreservedSecrets({
      ...form,
      cadence: {
        ...form.cadence,
        everyNMessages: numberOrUndefined(nums.everyNMessages),
        // 0/empty → undefined (no limit); the config rejects non-positive values.
        recentHours: floatOrUndefined(nums.recentHours) || undefined,
      },
      coverage: {
        minScore: floatOrUndefined(nums.minScore),
        relativeRatio: floatOrUndefined(nums.relativeRatio),
        maxSkills: numberOrUndefined(nums.maxSkills),
      },
    });
    const ok = await runAction("Saved analysis settings", () =>
      saveAnalysisSettings(request, next),
    );
    if (ok) setOpen(false);
  };

  // Editing a secret field marks it touched (so we don't re-inject the sentinel)
  // and clears any stale test result.
  const setExtractorKey = (value: string) => {
    setSecretTouched((s) => ({ ...s, extractor: true }));
    updateExtractor({ apiKey: value });
  };
  const setSkillGenKey = (value: string) => {
    setSecretTouched((s) => ({ ...s, skillGen: true }));
    update({ skillGen: { ...form.skillGen, apiKey: value } });
  };

  const cadence = form.cadence ?? {};
  const extractor = form.extractor ?? {};
  const skillGen = form.skillGen ?? {};
  const extractorProvider = extractor.provider ?? "naive";
  // The dropdown offers just "http" (any HTTP endpoint) and "naive"; a legacy
  // "cloud" config still behaves like http, so it maps to the http option here.
  const providerValue = extractorProvider === "naive" ? "naive" : "http";
  // Default to bearer (matches the legacy apiKey→Bearer behavior); switch to basic
  // for the hosted endpoint. A blank credential = no auth (a local sidecar needs none).
  const authScheme = extractor.authScheme ?? (extractor.username ? "basic" : "bearer");
  const skillGenProvider = skillGen.provider ?? "auto";

  return (
    <Dialog onOpenChange={(n) => void onOpenChange(n)} open={open}>
      <DialogTrigger render={<Button className="h-10" size="sm" variant="outline" />}>
        <Cog />
        Settings
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Analysis settings</DialogTitle>
          <DialogDescription>
            How chat is analyzed into intents, which model extracts them, how strictly they match
            skills, and how new skills are generated. Saved to your user-scope Ratel config.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pr-1">
          <SettingRow
            control={
              <Switch
                checked={form.enabled ?? true}
                onCheckedChange={(v) => update({ enabled: v })}
              />
            }
            hint="When off, Ratel stops capturing chat and running intent analysis."
            label="Enabled"
          />

          <SettingsSection
            title="Cadence"
            hint="When analysis is due (manual Run now always works)."
          >
            <SettingRow
              control={
                <Switch
                  checked={cadence.auto ?? false}
                  onCheckedChange={(v) => update({ cadence: { ...cadence, auto: v } })}
                />
              }
              hint="Let the gateway run analysis automatically in the background on a timer. Off by default - manual Run now always works."
              label="Automatic runs"
            />
            <div className="grid items-end gap-3 sm:grid-cols-2">
              <Field htmlFor="cadence-n" label="Every N messages">
                <Input
                  id="cadence-n"
                  inputMode="numeric"
                  onChange={(e) => setNum("everyNMessages", e.target.value)}
                  placeholder="10"
                  value={nums.everyNMessages ?? ""}
                />
              </Field>
              <SettingRow
                control={
                  <Switch
                    checked={cadence.onIdle ?? false}
                    onCheckedChange={(v) => update({ cadence: { ...cadence, onIdle: v } })}
                  />
                }
                hint="Also analyze when a session stops."
                label="On idle"
              />
            </div>
            <Field htmlFor="cadence-recent" label="Only chats active in the last (hours)">
              <Input
                id="cadence-recent"
                inputMode="decimal"
                onChange={(e) => setNum("recentHours", e.target.value)}
                placeholder="e.g. 5 - leave blank for no limit"
                value={nums.recentHours ?? ""}
              />
            </Field>
            <p className="px-1 text-muted-foreground text-xs">
              Bulk and automatic runs only analyze chats updated within this window - keeps a run
              from churning through every old chat. Per-chat “Analyze intents” (on the Chats page)
              ignores it.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Extractor"
            hint="Turns chat into claims + intents. A local sidecar and a hosted endpoint speak the same contract, so switching is just the URL (and auth)."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider">
                <Select
                  onValueChange={(v) => updateExtractor({ provider: v as never })}
                  value={providerValue}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP endpoint</SelectItem>
                    <SelectItem value="naive">Naive (no model)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {extractorProvider !== "naive" && (
                <Field htmlFor="ex-endpoint" label="Endpoint URL">
                  <Input
                    id="ex-endpoint"
                    onChange={(e) => updateExtractor({ endpoint: e.target.value })}
                    placeholder="http://127.0.0.1:8723"
                    value={extractor.endpoint ?? ""}
                  />
                </Field>
              )}
            </div>

            {extractorProvider !== "naive" && (
              <>
                <Field label="Authentication">
                  <Select
                    onValueChange={(v) => updateExtractor({ authScheme: v as "bearer" | "basic" })}
                    value={authScheme}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="basic">Basic auth</SelectItem>
                      <SelectItem value="bearer">Bearer token</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {authScheme === "basic" && (
                  <Field htmlFor="ex-user" label="Username">
                    <Input
                      autoComplete="off"
                      id="ex-user"
                      onChange={(e) => updateExtractor({ username: e.target.value })}
                      placeholder="e.g. ratel"
                      value={extractor.username ?? ""}
                    />
                  </Field>
                )}
                <Field htmlFor="ex-key" label={authScheme === "basic" ? "Password" : "API token"}>
                  <PasswordInput
                    id="ex-key"
                    onChange={(e) => setExtractorKey(e.target.value)}
                    placeholder={
                      savedSecrets.extractor
                        ? "•••• saved (type to replace)"
                        : "Leave blank for a local sidecar (no auth)"
                    }
                    value={extractor.apiKey ?? ""}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    disabled={testing || !extractor.endpoint}
                    onClick={() => void runTest()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {testing ? <Spinner /> : null}
                    Test connection
                  </Button>
                  {testResult ? (
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        testResult.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive"
                      }`}
                    >
                      {testResult.ok ? (
                        <CheckCircle2 className="size-4" />
                      ) : (
                        <XCircle className="size-4" />
                      )}
                      {testResult.ok ? "Connected" : "Failed"}
                      {testResult.detail ? (
                        <span className="text-muted-foreground">- {testResult.detail}</span>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              </>
            )}
            {extractorProvider !== "naive" && (
              <p className="px-1 text-muted-foreground text-xs">
                Local sidecar or hosted endpoint - same contract, just the URL. A local sidecar
                needs no auth (leave the credential blank); a hosted endpoint needs Basic or Bearer
                auth. Each endpoint serves its own model, so there's nothing to pick here.
              </p>
            )}
            {extractorProvider === "naive" && (
              <p className="px-1 text-muted-foreground text-xs">
                Naive mode needs no model - it records one intent per user message (good for testing
                the pipeline).
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Coverage matching"
            hint="How strictly intents match skills (BM25). Higher min score = fewer, stronger matches; lower relative cutoff = more skills per intent."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field htmlFor="cov-min" label="Min score">
                <Input
                  id="cov-min"
                  inputMode="decimal"
                  onChange={(e) => setNum("minScore", e.target.value)}
                  placeholder="1.0"
                  value={nums.minScore ?? ""}
                />
              </Field>
              <Field htmlFor="cov-ratio" label="Relative cutoff (0–1)">
                <Input
                  id="cov-ratio"
                  inputMode="decimal"
                  onChange={(e) => setNum("relativeRatio", e.target.value)}
                  placeholder="0.6"
                  value={nums.relativeRatio ?? ""}
                />
              </Field>
              <Field htmlFor="cov-max" label="Max skills">
                <Input
                  id="cov-max"
                  inputMode="numeric"
                  onChange={(e) => setNum("maxSkills", e.target.value)}
                  placeholder="4"
                  value={nums.maxSkills ?? ""}
                />
              </Field>
            </div>
          </SettingsSection>

          <SettingsSection title="Skill generation" hint="Used by “Offer New Skills”.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Provider">
                <Select
                  onValueChange={(v) => update({ skillGen: { ...skillGen, provider: v as never } })}
                  value={skillGenProvider}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (API key if set, else CLI)</SelectItem>
                    <SelectItem value="anthropic-api">Anthropic API</SelectItem>
                    <SelectItem value="claude-cli">Local claude CLI</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {skillGenProvider !== "claude-cli" && (
                <Field htmlFor="sg-key" label="Anthropic API key">
                  <PasswordInput
                    id="sg-key"
                    onChange={(e) => setSkillGenKey(e.target.value)}
                    placeholder={
                      savedSecrets.skillGen
                        ? "•••• saved (type to replace)"
                        : skillGenProvider === "auto"
                          ? "optional"
                          : "required"
                    }
                    value={skillGen.apiKey ?? ""}
                  />
                </Field>
              )}
              <Field label="Model">
                <Select
                  onValueChange={(v) =>
                    update({
                      skillGen: { ...skillGen, model: v && v !== SKILLGEN_DEFAULT ? v : "" },
                    })
                  }
                  value={skillGen.model ? skillGen.model : SKILLGEN_DEFAULT}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {skillGenModelOptions(skillGenProvider).map((opt) => (
                      <SelectItem
                        key={opt.value || SKILLGEN_DEFAULT}
                        value={opt.value || SKILLGEN_DEFAULT}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <p className="px-1 text-muted-foreground text-xs">
              The model used to author skills. This also sets the expected authoring time shown in
              the “Offer New Skills” progress bar.
            </p>
            {skillGenProvider === "claude-cli" && (
              <p className="px-1 text-muted-foreground text-xs">
                Uses your local <code className="font-mono">claude</code> CLI - no API key needed.
              </p>
            )}
          </SettingsSection>
        </div>

        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button disabled={busy} onClick={() => void save()} size="sm">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SettingsSection(props: { title: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-3 rounded-md border border-border p-3">
      <legend className="px-1 font-medium text-sm">{props.title}</legend>
      {props.hint && <p className="-mt-1 px-1 text-muted-foreground text-xs">{props.hint}</p>}
      {props.children}
    </fieldset>
  );
}

function Field(props: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.children}
    </div>
  );
}

/** A password input with a show/hide toggle. Reveals only what the user typed —
 *  saved secrets arrive blanked, so the toggle can never expose a stored value. */
function PasswordInput(props: {
  id?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        autoComplete="off"
        className="pr-10"
        id={props.id}
        onChange={props.onChange}
        placeholder={props.placeholder}
        type={show ? "text" : "password"}
        value={props.value}
      />
      <button
        aria-label={show ? "Hide" : "Show"}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setShow((s) => !s)}
        tabIndex={-1}
        type="button"
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function numToStr(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

function floatOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function SettingRow(props: { label: string; hint?: string; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <span className="font-medium text-sm">{props.label}</span>
        {props.hint && <span className="text-muted-foreground text-xs">{props.hint}</span>}
      </div>
      {props.control}
    </div>
  );
}

/** Full-bleed "analyzing" panel shown in place of the empty state while a run is in flight. */
function AnalyzingState() {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md justify-items-center gap-4">
        <PrismSweep dotSize={4} pattern="full" size={40} speed={1.4} />
        <div>
          <h3 className="font-medium">Analyzing chat through the extractor…</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            Results appear as each session finishes.
          </p>
        </div>
      </div>
    </section>
  );
}

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md gap-3">
        <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
          <Target className="size-5" />
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

function numberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
