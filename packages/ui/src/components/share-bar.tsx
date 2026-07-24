import { cn } from "@/lib/utils";

function sharePercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function ShareBar(props: { className?: string; color: string; total: number; value: number }) {
  const percent = sharePercent(props.value, props.total);

  return (
    <div
      aria-hidden="true"
      className={cn("h-1.5 w-24 overflow-hidden rounded-full bg-muted", props.className)}
    >
      <div
        className="h-full rounded-full"
        style={{
          backgroundColor: props.color,
          width: `${percent}%`,
        }}
      />
    </div>
  );
}

export { ShareBar, sharePercent };
