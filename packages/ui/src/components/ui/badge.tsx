import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2.5 text-xs leading-none font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/30 [&>svg]:pointer-events-none [&>svg]:size-3.5!",
  {
    variants: {
      variant: {
        default: "border-coral/40 bg-coral/15 text-coral [a]:hover:bg-coral/20",
        secondary:
          "border-border bg-secondary/60 text-secondary-foreground [a]:hover:bg-secondary/80 dark:bg-forest/50 dark:[a]:hover:bg-forest/70",
        destructive:
          "border-coral/40 bg-coral/10 text-coral focus-visible:ring-coral/25 [a]:hover:bg-coral/20",
        warning:
          "border-amber-300/70 bg-amber-50 text-amber-900 focus-visible:ring-amber-500/20 dark:border-amber-400/40 dark:bg-amber-500/15 dark:text-amber-200",
        muted:
          "border-border bg-muted text-muted-foreground focus-visible:ring-muted-foreground/20 [a]:hover:bg-muted/80",
        outline:
          "border-border bg-transparent text-foreground [a]:hover:bg-secondary/40 [a]:hover:text-foreground dark:[a]:hover:bg-forest/60",
        ghost:
          "text-muted-foreground hover:bg-secondary/40 hover:text-foreground dark:hover:bg-forest/60",
        link: "text-coral underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
