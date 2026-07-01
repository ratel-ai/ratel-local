import type { ReactNode } from "react";
import { ShareBar, sharePercent } from "@/components/share-bar";
import { Badge } from "@/components/ui/badge";
import type {
  AgentHostKind,
  AgentPosture,
  ClaudeStatuslineState,
  DetectedAgentHostSummary,
} from "@/lib/agent-hosts";
import { cn } from "@/lib/utils";

/**
 * Presentational kit for agent hosts (Claude Code / Codex): icons, brand colors,
 * posture copy, status badges, and the small count/coverage labels. Shared by the
 * agent setup pages and the onboarding flow so both render agents identically.
 */

const CODEX_ICON_SRC = new URL("../assets/codex-color.svg", import.meta.url).href;
const CLAUDE_CODE_ICON_SRC = new URL("../assets/claudecode-color.svg", import.meta.url).href;
export const CODEX_SOURCE_COLOR = "#7A9DFF";
export const CLAUDE_CODE_SOURCE_COLOR = "#D97757";

export function agentColor(kind: AgentHostKind): string {
  return kind === "claude-code" ? CLAUDE_CODE_SOURCE_COLOR : CODEX_SOURCE_COLOR;
}

export function agentDisplayName(kind: AgentHostKind): string {
  return kind === "claude-code" ? "Claude Code" : "Codex";
}

export const POSTURE_COPY: Record<
  AgentPosture,
  { label: string; tone: "default" | "secondary" | "outline"; description: string }
> = {
  unavailable: {
    label: "Unavailable",
    tone: "outline",
    description: "No config file found at known paths.",
  },
  empty: {
    label: "Empty",
    tone: "secondary",
    description: "Config exists but has no MCP entries.",
  },
  "not-linked": {
    label: "Not linked",
    tone: "default",
    description: "Native MCP entries exist without Ratel.",
  },
  "ratel-only": {
    label: "Ratel only",
    tone: "secondary",
    description: "Only Ratel gateway entries are configured.",
  },
  mixed: {
    label: "Mixed",
    tone: "default",
    description: "Native and Ratel entries are both present.",
  },
};

export function AgentIcon(props: { kind: AgentHostKind; size?: "md" | "lg" }) {
  const className = props.size === "lg" ? "size-16" : "size-12";
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-md border border-border bg-background",
        className,
      )}
    >
      {props.kind === "claude-code" ? <ClaudeMark /> : <CodexMark />}
    </div>
  );
}

export function AgentIconFrame(props: { kind: AgentHostKind }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded border border-border bg-background">
      {props.kind === "claude-code" ? (
        <ClaudeMark className="size-3.5" />
      ) : (
        <CodexMark className="size-3.5" />
      )}
    </span>
  );
}

function ClaudeMark(props: { className?: string } = {}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("size-2/3", props.className)}
      src={CLAUDE_CODE_ICON_SRC}
    />
  );
}

function CodexMark(props: { className?: string } = {}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      className={cn("size-2/3", props.className)}
      src={CODEX_ICON_SRC}
    />
  );
}

export function LinkStatusBadge(props: { host: DetectedAgentHostSummary }) {
  if (props.host.posture === "unavailable") {
    return <StatusBadge tone="muted">Unavailable</StatusBadge>;
  }
  if (props.host.ratelEntryCount > 0) {
    return <StatusBadge tone="success">Linked</StatusBadge>;
  }
  return <StatusBadge tone="muted">Not linked</StatusBadge>;
}

export function ClaudeStatuslineBadge(props: { state: ClaudeStatuslineState }) {
  if (props.state.status === "installed") {
    return <StatusBadge tone="success">Installed</StatusBadge>;
  }
  if (props.state.status === "other") {
    return <StatusBadge tone="warning">Other configured</StatusBadge>;
  }
  return <StatusBadge tone="muted">Not installed</StatusBadge>;
}

export function StatusBadge(props: { children: ReactNode; tone: "muted" | "success" | "warning" }) {
  const toneClass =
    props.tone === "success"
      ? "border-emerald-300/70 bg-emerald-50 text-emerald-900 dark:border-emerald-400/40 dark:bg-emerald-500/15 dark:text-emerald-200"
      : props.tone === "warning"
        ? "border-amber-300/70 bg-amber-50 text-amber-900 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200"
        : "border-border bg-muted text-muted-foreground";
  const dotClass =
    props.tone === "success"
      ? "bg-emerald-500"
      : props.tone === "warning"
        ? "bg-amber-500"
        : "bg-muted-foreground/50";
  return (
    <Badge className={cn("gap-1.5 rounded-full px-2 font-medium", toneClass)} variant="outline">
      <span className={cn("size-1.5 rounded-full", dotClass)} />
      {props.children}
    </Badge>
  );
}

export function AgentCountLabel(props: { count: number; label: string; tone?: "warning" }) {
  const hasWarning = props.tone === "warning" && props.count > 0;
  return (
    <span
      className={cn(
        "block truncate font-mono text-xs",
        hasWarning ? "text-amber-700 dark:text-amber-400" : "text-foreground",
      )}
    >
      {props.count} {props.label}
    </span>
  );
}

export function AgentCoverageLabel(props: { color: string; total: number; value: number }) {
  if (props.total <= 0) {
    return <span className="font-mono text-muted-foreground text-xs">N/A</span>;
  }

  return (
    <div className="flex items-center justify-end gap-3">
      <ShareBar color={props.color} total={props.total} value={props.value} />
      <span className="w-9 text-right font-mono text-xs">
        {sharePercent(props.value, props.total)}%
      </span>
    </div>
  );
}
