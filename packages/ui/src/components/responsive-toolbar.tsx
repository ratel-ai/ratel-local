import type { ComponentProps, ReactNode } from "react";
import { ShortcutHint } from "@/components/shortcut-hint";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ResponsiveToolbarButtonProps = Omit<ComponentProps<typeof Button>, "children" | "size"> & {
  icon: ReactNode;
  label: string;
  shortcut?: string;
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
  label,
  shortcut,
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
        {shortcut ? (
          <ShortcutHint
            className="hidden lg:inline-flex"
            keyClassName="bg-background/70"
            shortcut={shortcut}
          />
        ) : null}
      </TooltipTrigger>
      <TooltipContent className="md:hidden">{label}</TooltipContent>
    </Tooltip>
  );
}

function ResponsiveToolbarLabeledButton({
  className,
  icon,
  label,
  shortcut,
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
      {shortcut ? (
        <ShortcutHint
          className="hidden lg:inline-flex"
          keyClassName="bg-background/70"
          shortcut={shortcut}
        />
      ) : null}
    </Button>
  );
}

export {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
  ResponsiveToolbarLabeledButton,
};
