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

export function BrandLogo({ className, suffix = "MCP" }: { className?: string; suffix?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <RatelBadger className="h-[17px] w-[37px] bg-brand-green dark:bg-brand-cream" />
      <span className="text-sm font-semibold text-foreground tracking-tight">
        Ratel <span className="font-normal text-muted-foreground">{suffix}</span>
      </span>
    </span>
  );
}
