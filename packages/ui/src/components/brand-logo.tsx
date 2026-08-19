import { cn } from "@/lib/utils";

export function RatelBadger({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={className}
      style={{
        display: "inline-block",
        WebkitMaskImage: "url(/brand/ratel-badger.png)",
        maskImage: "url(/brand/ratel-badger.png)",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

export function BrandLogo({
  className,
  suffix = "Local",
}: {
  className?: string;
  suffix?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <RatelBadger className="h-5 w-11 shrink-0 bg-brand-green dark:bg-cream" />
      <span className="whitespace-nowrap font-display text-sm font-semibold tracking-tight text-cream">
        Ratel <span className="font-normal text-warm-muted">{suffix}</span>
      </span>
    </span>
  );
}
