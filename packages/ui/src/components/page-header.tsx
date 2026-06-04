import { MenuIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { useSidebar } from "@/components/ui/sidebar";
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

function PageHeaderSidebarTrigger({ className, ...props }: ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();

  return (
    <Button
      aria-label="Toggle menu"
      className={cn(
        "size-10 rounded-[min(var(--radius-md),12px)] border border-border bg-card hover:bg-muted/60 md:hidden",
        className,
      )}
      onClick={toggleSidebar}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      <MenuIcon />
      <span className="sr-only">Toggle menu</span>
    </Button>
  );
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
