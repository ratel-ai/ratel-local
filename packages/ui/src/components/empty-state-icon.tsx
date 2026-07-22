import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function EmptyStateIcon({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto rounded-md border border-coral/30 bg-coral/10 p-2 text-coral [&_svg]:size-5",
        className,
      )}
      {...props}
    />
  );
}
