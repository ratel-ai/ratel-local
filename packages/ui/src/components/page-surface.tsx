import type * as React from "react";
import { cn } from "@/lib/utils";

function PageSurface({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40",
        className,
      )}
      data-slot="page-surface"
      {...props}
    />
  );
}

function PageSurfaceHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("border-forest-300 border-b px-4 py-4 sm:px-5", className)}
      data-slot="page-surface-header"
      {...props}
    />
  );
}

function PageSurfaceContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("px-4 py-4 sm:px-5", className)}
      data-slot="page-surface-content"
      {...props}
    />
  );
}

function PageSurfaceFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("border-forest-300 border-t bg-background/20 px-4 py-3 sm:px-5", className)}
      data-slot="page-surface-footer"
      {...props}
    />
  );
}

export { PageSurface, PageSurfaceContent, PageSurfaceFooter, PageSurfaceHeader };
