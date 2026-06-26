import type * as React from "react";
import { cn } from "@/lib/utils";

function DetailGrid({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="detail-grid"
      className={cn(
        "-mx-4 grid gap-3 border-border border-y bg-muted/15 px-4 py-4 sm:-mx-6 sm:px-6 md:grid-cols-[10rem_minmax(0,1fr)]",
        className,
      )}
      {...props}
    />
  );
}

function DetailLabel({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="detail-label"
      className={cn("font-mono text-xs text-muted-foreground uppercase", className)}
      {...props}
    />
  );
}

export { DetailGrid, DetailLabel };
