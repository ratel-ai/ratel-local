import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@/lib/utils";

type ScrollMask = "none" | "x" | "y" | "both" | "top" | "bottom" | "left" | "right";

const scrollMaskClassName: Record<ScrollMask, string | undefined> = {
  none: undefined,
  x: "scroll-mask-x scroll-mask-x-from-88%",
  y: "scroll-mask-y scroll-mask-y-from-88%",
  both: "scroll-mask-x scroll-mask-y scroll-mask-x-from-88% scroll-mask-y-from-88%",
  top: "scroll-mask-t scroll-mask-t-from-88%",
  bottom: "scroll-mask-b scroll-mask-b-from-88%",
  left: "scroll-mask-l scroll-mask-l-from-88%",
  right: "scroll-mask-r scroll-mask-r-from-88%",
};

function ScrollArea({
  className,
  children,
  scrollMask = "y",
  viewportClassName,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollMask?: ScrollMask;
  viewportClassName?: string;
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          "size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1",
          scrollMaskClassName[scrollMask],
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "flex touch-none p-px transition-colors select-none data-horizontal:h-2.5 data-horizontal:flex-col data-horizontal:border-t data-horizontal:border-t-transparent data-vertical:h-full data-vertical:w-2.5 data-vertical:border-l data-vertical:border-l-transparent",
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
