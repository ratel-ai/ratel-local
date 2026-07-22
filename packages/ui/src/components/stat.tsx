import { cn } from "@/lib/utils";

type StatTone = "amber" | "coral" | "default" | "green";

const STAT_TONE: Record<StatTone, string> = {
  amber: "text-ctx-tools",
  coral: "text-coral",
  default: "text-cream",
  green: "text-green",
};

function Stat({
  label,
  sub,
  tone = "default",
  value,
}: {
  label: string;
  sub?: string;
  tone?: StatTone;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div
        className={cn(
          "mt-1.5 font-display text-3xl font-semibold tabular-nums tracking-tight sm:text-[2.5rem] sm:leading-none",
          STAT_TONE[tone],
        )}
      >
        {value}
      </div>
      {sub ? <div className="mt-1.5 text-xs text-warm-muted">{sub}</div> : null}
    </div>
  );
}

export type { StatTone };
export { Stat };
