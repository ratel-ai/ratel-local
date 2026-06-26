import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

function PageHeader({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn("grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end", className)}
      {...props}
    />
  );
}

function PageHeaderContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-w-0", className)} {...props} />;
}

function PageHeaderBackRow({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-3", className)} {...props} />;
}

function PageHeaderTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-xl font-semibold tracking-tight", className)} {...props} />;
}

function PageHeaderDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-1 max-w-2xl text-sm text-muted-foreground", className)} {...props} />;
}

function PageHeaderActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 lg:justify-end", className)} {...props} />
  );
}

/**
 * Legacy slot for the old shadcn sidebar's mobile hamburger. The shell now uses
 * a header + always-visible nav rail (a horizontal strip on mobile), so there's
 * nothing to toggle — this renders nothing and is kept only so existing page
 * headers keep compiling. Safe to delete once the pages drop the reference.
 */
function PageHeaderSidebarTrigger(_props: ComponentProps<"button">) {
  return null;
}

export {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
  PageHeaderTitle,
};
