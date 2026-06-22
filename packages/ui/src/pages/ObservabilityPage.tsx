import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import useMeasure from "react-use-measure";
import { useRatelApp } from "@/App";
import { Button } from "@/components/ui/button";
import { fetchObservability, type ObservabilityResponse, type RunLogEntry } from "@/lib/intents";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: ObservabilityResponse };

/**
 * Analysis-run telemetry, rendered as a tab inside the Intents page (no page
 * header of its own — the Intents page provides it).
 */
export function ObservabilityPanel() {
  const { request } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await fetchObservability(request);
      setState({ status: "ready", data });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load observability data",
      });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const data = state.status === "ready" ? state.data : null;

  return (
    <div className="flex flex-col gap-4">
      <p className="px-1 text-muted-foreground text-sm">
        A history of every analysis run — when Ratel read your captured chats and extracted intents,
        how long it took, and what it found. Use it to confirm analysis is running and spot
        failures.
      </p>

      <Glossary />

      {state.status === "loading" && (
        <p className="px-1 text-muted-foreground text-sm">Loading observability data…</p>
      )}

      {state.status === "error" && (
        <EmptyState title="Couldn't load observability data" description={state.message}>
          <Button onClick={() => void load()} size="sm" variant="outline">
            Retry
          </Button>
        </EmptyState>
      )}

      {data && data.runs.length === 0 && (
        <EmptyState
          title="No analysis runs recorded yet."
          description="Click “Run now” above to analyze your captured chats; each run's timing and per-session results show up here."
        />
      )}

      {data && data.runs.length > 0 && (
        <>
          <SummaryHeader runs={data.runs} summary={data.summary} />
          <RunsChart runs={data.runs} />
          <RunsList runs={data.runs} />
        </>
      )}
    </div>
  );
}

function SummaryHeader(props: { runs: RunLogEntry[]; summary: ObservabilityResponse["summary"] }) {
  const { runs, summary } = props;

  // Stats the server summary doesn't already give us, derived from the run log.
  const totalIntents = runs.reduce((sum, run) => sum + run.totalIntents, 0);
  let totalSessions = 0;
  let cachedSessions = 0;
  for (const run of runs) {
    totalSessions += run.sessions.length;
    cachedSessions += run.sessions.filter((session) => session.cacheHit).length;
  }
  const cacheHitRate =
    totalSessions > 0 ? `${Math.round((cachedSessions / totalSessions) * 100)}%` : "—";

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <SummaryCard
        hint="How many times analysis has run"
        label="Total runs"
        value={String(summary.totalRuns)}
      />
      <SummaryCard
        hint="When analysis last ran"
        label="Last run"
        value={summary.lastRunAt ? relativeTime(summary.lastRunAt) : "—"}
      />
      <SummaryCard
        hint="Typical time one run takes"
        label="Avg duration"
        value={formatDuration(summary.avgDurationMs)}
      />
      <SummaryCard
        hint="Intents extracted across all runs"
        label="Intents found"
        value={String(totalIntents)}
      />
      <SummaryCard
        hint="Sessions reused instead of re-run"
        label="Cache hit rate"
        value={cacheHitRate}
      />
      <SummaryCard
        hint="Intents with no matching skill, per run"
        label="Avg gaps / run"
        value={summary.avgGapsPerRun.toFixed(1)}
      />
    </div>
  );
}

function SummaryCard(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <p className="text-muted-foreground text-xs">{props.label}</p>
      <p className="mt-0.5 font-medium text-lg">{props.value}</p>
      {props.hint && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{props.hint}</p>}
    </div>
  );
}

/** Collapsible plain-language key for the terms on this page. */
function Glossary() {
  return (
    <details className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        How to read this page
      </summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <GlossaryItem term="Run">
          One pass of the analyzer over your captured chats. Triggered by “Run now” or, if enabled,
          automatically on a timer.
        </GlossaryItem>
        <GlossaryItem term="Trigger">
          What started the run — <span className="font-mono text-xs">manual</span> (you clicked Run
          now), <span className="font-mono text-xs">cadence</span> (the automatic timer), or{" "}
          <span className="font-mono text-xs">idle</span> (a session went quiet).
        </GlossaryItem>
        <GlossaryItem term="Intent">
          Something you repeatedly try to get an agent to do, extracted from the conversation.
        </GlossaryItem>
        <GlossaryItem term="Gap">
          An intent that no managed skill covers yet — a candidate for “Offer New Skills” on the
          Intents page.
        </GlossaryItem>
        <GlossaryItem term="Session">
          One captured chat that a run looked at. A run can process several sessions.
        </GlossaryItem>
        <GlossaryItem term="Cached">
          The conversation hadn’t changed since last time, so the result was reused instead of
          re-running the model — faster and cheaper.
        </GlossaryItem>
      </dl>
    </details>
  );
}

function GlossaryItem(props: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-foreground text-xs">{props.term}</dt>
      <dd className="text-muted-foreground text-xs">{props.children}</dd>
    </div>
  );
}

// Fixed chart height; width is measured at runtime so the viewBox maps 1:1 to
// pixels (no aspect-ratio stretching → round markers, undistorted lines).
const CHART_H = 180;
const CHART_PAD = { top: 16, right: 16, bottom: 22, left: 30 };
const GRID_LINES = 3;

interface ChartPoint {
  key: string;
  at: string;
  totalIntents: number;
  totalGaps: number;
  x: number;
  intentY: number;
  gapY: number;
}

function RunsChart(props: { runs: RunLogEntry[] }) {
  const [ref, bounds] = useMeasure();
  const width = Math.max(320, Math.round(bounds.width));
  const plotW = width - CHART_PAD.left - CHART_PAD.right;
  const plotH = CHART_H - CHART_PAD.top - CHART_PAD.bottom;

  // Oldest-to-newest, capped to the last 30 runs. A dependency-free inline-SVG
  // line chart — recharts is intentionally avoided (it broke the dev bundle).
  const recent = [...props.runs].slice(0, 30).reverse();
  const max = Math.max(1, ...recent.map((run) => Math.max(run.totalIntents, run.totalGaps)));

  const points: ChartPoint[] = recent.map((run, index) => {
    // One point centers in the plot; otherwise spread evenly left→right.
    const x =
      recent.length === 1
        ? CHART_PAD.left + plotW / 2
        : CHART_PAD.left + (plotW * index) / (recent.length - 1);
    const yFor = (value: number) => CHART_PAD.top + plotH - (value / max) * plotH;
    return {
      key: run.runId,
      at: run.at,
      totalIntents: run.totalIntents,
      totalGaps: run.totalGaps,
      x,
      intentY: yFor(run.totalIntents),
      gapY: yFor(run.totalGaps),
    };
  });

  const intentPath = toPath(points, (p) => p.intentY);
  const gapPath = toPath(points, (p) => p.gapY);
  const baselineY = CHART_PAD.top + plotH;

  return (
    <section className="rounded-md border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <h2 className="font-medium text-sm">Intents &amp; gaps over time</h2>
        <div className="flex items-center gap-3 text-muted-foreground text-xs">
          <LegendSwatch color="var(--chart-1)" label="Intents" />
          <LegendSwatch color="var(--chart-2)" label="Gaps" />
        </div>
      </div>
      <div className="w-full" ref={ref}>
        {bounds.width > 0 && (
          <svg
            aria-label="Intents and gaps per run over time"
            height={CHART_H}
            role="img"
            viewBox={`0 0 ${width} ${CHART_H}`}
            width={width}
          >
            {/* Horizontal gridlines. */}
            {Array.from({ length: GRID_LINES }, (_, i) => {
              const y = CHART_PAD.top + (plotH * i) / (GRID_LINES - 1);
              return (
                <line
                  className="stroke-border"
                  key={`grid-${y}`}
                  opacity={i === GRID_LINES - 1 ? 0.9 : 0.4}
                  strokeWidth={1}
                  x1={CHART_PAD.left}
                  x2={width - CHART_PAD.right}
                  y1={y}
                  y2={y}
                />
              );
            })}

            {/* Y-axis labels (max + 0). */}
            <text
              className="fill-muted-foreground"
              fontSize={10}
              textAnchor="end"
              x={CHART_PAD.left - 6}
              y={CHART_PAD.top + 3}
            >
              {max}
            </text>
            <text
              className="fill-muted-foreground"
              fontSize={10}
              textAnchor="end"
              x={CHART_PAD.left - 6}
              y={baselineY + 3}
            >
              0
            </text>

            {/* Series lines. */}
            <path
              d={gapPath}
              fill="none"
              stroke="var(--chart-2)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />
            <path
              d={intentPath}
              fill="none"
              stroke="var(--chart-1)"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />

            {/* Markers with tooltips. */}
            {points.map((p) => (
              <g key={p.key}>
                <circle cx={p.x} cy={p.gapY} fill="var(--chart-2)" r={3}>
                  <title>{markerTitle(p)}</title>
                </circle>
                <circle cx={p.x} cy={p.intentY} fill="var(--chart-1)" r={3}>
                  <title>{markerTitle(p)}</title>
                </circle>
              </g>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}

/** Build an SVG polyline `d` string; falls back to a tiny dot for a single point. */
function toPath(points: ChartPoint[], y: (p: ChartPoint) => number): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x} ${y(p)} L ${p.x} ${y(p)}`;
  }
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${y(p)}`).join(" ");
}

function markerTitle(p: ChartPoint): string {
  const intents = `${p.totalIntents} intent${p.totalIntents === 1 ? "" : "s"}`;
  const gaps = `${p.totalGaps} gap${p.totalGaps === 1 ? "" : "s"}`;
  return `${shortDateTime(p.at)} · ${intents} / ${gaps}`;
}

function LegendSwatch(props: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="size-2 rounded-sm" style={{ backgroundColor: props.color }} />
      {props.label}
    </span>
  );
}

function RunsList(props: { runs: RunLogEntry[] }) {
  return (
    <div className="grid gap-2">
      <span className="px-1 text-muted-foreground text-xs">
        {props.runs.length} run{props.runs.length === 1 ? "" : "s"}
      </span>
      {props.runs.map((run) => (
        <RunRow key={run.runId} run={run} />
      ))}
    </div>
  );
}

function RunRow(props: { run: RunLogEntry }) {
  const { run } = props;
  const [open, setOpen] = useState(false);
  const hasErrors = run.sessions.some((session) => !session.ok);
  return (
    <div className="rounded-md border border-border bg-card">
      <button
        className="flex w-full items-start gap-3 p-3 text-left"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="font-medium text-sm">{relativeTime(run.at)}</strong>
            <span className="text-muted-foreground text-xs">{run.trigger}</span>
            {run.model && <Chip>{run.model}</Chip>}
            {hasErrors && (
              <Chip tone="error">{run.sessions.filter((session) => !session.ok).length} error</Chip>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
            <span>{formatDuration(run.durationMs)}</span>
            <span aria-hidden>·</span>
            <span>
              {run.totalIntents} intent{run.totalIntents === 1 ? "" : "s"} / {run.totalGaps} gap
              {run.totalGaps === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>
              {run.sessions.length} session{run.sessions.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </button>
      {open && run.sessions.length > 0 && (
        <div className="grid gap-1.5 border-border border-t p-3">
          {run.sessions.map((session) => (
            <div
              className={
                session.ok
                  ? "rounded border border-border bg-muted/20 p-2"
                  : "rounded border border-destructive/40 bg-destructive/5 p-2"
              }
              key={session.sessionId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono text-xs">{session.sessionId}</span>
                {session.host && (
                  <span className="text-muted-foreground text-xs">{session.host}</span>
                )}
                {session.ok ? <Chip tone="success">ok</Chip> : <Chip tone="error">error</Chip>}
                {session.cacheHit && <Chip>cached</Chip>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                <span>
                  {session.intents} intent{session.intents === 1 ? "" : "s"} / {session.gaps} gap
                  {session.gaps === 1 ? "" : "s"}
                </span>
                <span aria-hidden>·</span>
                <span>
                  {session.turns} turn{session.turns === 1 ? "" : "s"}
                </span>
                <span aria-hidden>·</span>
                <span>{formatDuration(session.latencyMs)}</span>
              </div>
              {!session.ok && session.error && (
                <p className="mt-1 text-destructive text-xs">{session.error}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip(props: { children: ReactNode; tone?: "success" | "error" }) {
  const tone = props.tone;
  return (
    <span
      className={
        tone === "success"
          ? "rounded-full border border-emerald-300/70 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
          : tone === "error"
            ? "rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive"
            : "rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
      }
    >
      {props.children}
    </span>
  );
}

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md gap-3">
        <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
          <Activity className="size-5" />
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

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
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

/** "3 Mar 14:02" — compact day/month + time, for chart marker tooltips. */
function shortDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.toLocaleDateString([], { day: "numeric", month: "short" });
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}
