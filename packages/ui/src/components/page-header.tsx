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
  return (
    <h1
      className={cn("font-display text-2xl font-bold tracking-tight text-cream", className)}
      {...props}
    />
  );
}

function PageHeaderDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("mt-1.5 max-w-2xl text-pretty text-sm text-warm-muted", className)}
      {...props}
    />
  );
}

function PageHeaderActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("flex min-w-0 items-start gap-2 lg:justify-end", className)} {...props} />
  );
}

export {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
};
