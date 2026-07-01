import { Check } from "lucide-react";
import {
  AgentCountLabel,
  AgentIcon,
  agentDisplayName,
  LinkStatusBadge,
  POSTURE_COPY,
} from "@/components/agent-identity";
import type { DetectedAgentHostSummary } from "@/lib/agent-hosts";
import { cn } from "@/lib/utils";

/**
 * Selectable agent tile for the onboarding "choose an agent" step. Built from the shared
 * agent-identity primitives so it reads identically to the agent directory. Undetected
 * hosts render disabled with the detection reason.
 */
export function AgentPickCard(props: {
  host: DetectedAgentHostSummary;
  onSelect: () => void;
  selected: boolean;
  unmanagedSkillCount: number;
}) {
  const present = props.host.detection.present;
  const posture = POSTURE_COPY[props.host.posture];
  return (
    <button
      aria-pressed={props.selected}
      className={cn(
        "group relative grid w-full gap-4 rounded-xl border bg-card/35 p-4 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        props.selected
          ? "border-foreground/60 bg-card/60"
          : "border-border hover:border-foreground/25",
        !present && "cursor-not-allowed opacity-60 hover:border-border",
      )}
      disabled={!present}
      onClick={props.onSelect}
      type="button"
    >
      <div className="flex items-start gap-3">
        <AgentIcon kind={props.host.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate font-semibold tracking-tight">
              {props.host.displayName ?? agentDisplayName(props.host.kind)}
            </h3>
            {props.selected ? (
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-background">
                <Check className="size-3" />
              </span>
            ) : null}
          </div>
          <p className="mt-1 line-clamp-2 text-muted-foreground text-sm">
            {present
              ? posture.description
              : (props.host.detection.reasons[0] ?? "Not detected on this machine.")}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <AgentCountLabel count={props.host.nativeEntryCount} label="native tools" />
        <AgentCountLabel count={props.unmanagedSkillCount} label="skills" tone="warning" />
        <LinkStatusBadge host={props.host} />
      </div>
    </button>
  );
}
