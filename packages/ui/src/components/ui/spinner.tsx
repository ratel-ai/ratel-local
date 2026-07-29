import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

function Spinner({
  className,
  decorative = false,
  ...props
}: React.ComponentProps<"svg"> & { decorative?: boolean }) {
  const accessibility = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ "aria-label": "Loading", role: "status" } as const);
  return (
    <Loader2Icon {...accessibility} className={cn("size-4 animate-spin", className)} {...props} />
  );
}

export { Spinner };
