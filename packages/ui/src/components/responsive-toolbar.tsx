import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ResponsiveToolbarButtonProps = Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  icon: ReactNode;
  kbd?: string;
  label: string;
};

function ResponsiveToolbar(props: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn("flex min-w-0 flex-wrap items-center gap-2 lg:justify-end", props.className)}
    />
  );
}

function ResponsiveToolbarGroup(props: ComponentProps<typeof ButtonGroup>) {
  return <ButtonGroup {...props} className={cn("shrink-0", props.className)} />;
}

function ResponsiveToolbarButton({
  className,
  icon,
  kbd,
  label,
  variant = "outline",
  ...props
}: ResponsiveToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "h-10 min-w-10 px-0 md:w-auto md:px-3 [&_svg:not([class*='size-'])]:size-4",
              className,
            )}
            size="sm"
            variant={variant}
            {...props}
          />
        }
      >
        {icon}
        <span className="hidden md:inline">{label}</span>
        {kbd ? <Kbd className="hidden bg-background/70 lg:inline-flex">{kbd}</Kbd> : null}
      </TooltipTrigger>
      <TooltipContent className="md:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}

function ResponsiveToolbarLabeledButton({
  className,
  icon,
  kbd,
  label,
  variant = "outline",
  ...props
}: ResponsiveToolbarButtonProps) {
  return (
    <Button
      aria-label={label}
      className={cn("h-10 min-w-10 w-auto px-3 [&_svg:not([class*='size-'])]:size-4", className)}
      size="sm"
      variant={variant}
      {...props}
    >
      {icon}
      <span>{label}</span>
      {kbd ? <Kbd className="hidden bg-background/70 lg:inline-flex">{kbd}</Kbd> : null}
    </Button>
  );
}

export {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
  ResponsiveToolbarLabeledButton,
};
