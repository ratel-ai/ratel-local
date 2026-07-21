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
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2.5 group-data-[collapsible=icon]:gap-0",
        className,
      )}
    >
      <RatelBadger className="h-[22px] w-[48px] shrink-0 bg-brand-green transition-[width,height] dark:bg-brand-cream group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:w-6" />
      <span className="whitespace-nowrap font-display text-lg font-medium text-foreground tracking-[-0.03em] group-data-[collapsible=icon]:hidden">
        Ratel <span className="font-normal text-muted-foreground">{suffix}</span>
      </span>
    </span>
  );
}
