import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[10px] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-colors duration-200 outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/30 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-cream bg-cream text-[var(--brand-ink)] shadow-[0_1px_0_rgba(255,255,255,0.4)_inset] hover:border-white hover:bg-white",
        outline:
          "border-border bg-card/35 text-foreground hover:border-foreground/20 hover:bg-secondary/40 aria-expanded:border-border aria-expanded:bg-secondary/50 aria-expanded:text-foreground dark:bg-forest/40 dark:hover:bg-forest/70",
        secondary:
          "border-border bg-secondary/70 text-secondary-foreground hover:bg-secondary aria-expanded:bg-secondary aria-expanded:text-secondary-foreground dark:bg-forest/40 dark:hover:bg-forest/70",
        ghost:
          "text-muted-foreground hover:bg-secondary/40 hover:text-foreground aria-expanded:bg-secondary/50 aria-expanded:text-foreground dark:hover:bg-forest/60",
        destructive:
          "border-coral/40 bg-transparent text-coral hover:border-coral/60 hover:bg-coral/10 focus-visible:border-coral/60 focus-visible:ring-coral/25",
        link: "text-coral underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 rounded-[min(var(--radius-md),12px)] px-3 text-sm in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-3.5 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "h-9 min-h-9 w-9 min-w-9",
        "icon-xs":
          "h-6 min-h-6 w-6 min-w-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "h-8 min-h-8 w-8 min-w-8 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "h-10 min-h-10 w-10 min-w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
