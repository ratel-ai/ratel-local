import { Slot } from "@radix-ui/react-slot";
import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { createContext, type ReactNode, useContext, useMemo, useRef, useState } from "react";
import useMeasure from "react-use-measure";
import { Drawer } from "vaul";

// ============================================================================
// Types
// ============================================================================

type ViewComponent = React.ComponentType<Record<string, unknown>>;

interface ViewsRegistry {
  [viewName: string]: ViewComponent;
}

// ============================================================================
// Context
// ============================================================================

interface FamilyDrawerContextValue {
  isOpen: boolean;
  view: string;
  setView: (view: string) => void;
  opacityDuration: number;
  elementRef: ReturnType<typeof useMeasure>[0];
  bounds: ReturnType<typeof useMeasure>[1];
  views: ViewsRegistry | undefined;
}

const FamilyDrawerContext = createContext<FamilyDrawerContextValue | undefined>(undefined);

function useFamilyDrawer() {
  const context = useContext(FamilyDrawerContext);
  if (!context) {
    throw new Error("FamilyDrawer components must be used within FamilyDrawerRoot");
  }
  return context;
}

// ============================================================================
// Root Component
// ============================================================================

interface FamilyDrawerRootProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultView?: string;
  onViewChange?: (view: string) => void;
  views?: ViewsRegistry;
}

function FamilyDrawerRoot({
  children,
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  defaultView = "default",
  onViewChange,
  views: customViews,
}: FamilyDrawerRootProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [view, setView] = useState(defaultView);
  const [elementRef, bounds] = useMeasure();
  const previousHeightRef = useRef<number>(0);

  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;

  const opacityDuration = useMemo(() => {
    const currentHeight = bounds.height;
    const previousHeight = previousHeightRef.current;

    const MIN_DURATION = 0.15;
    const MAX_DURATION = 0.27;

    if (!previousHeightRef.current) {
      previousHeightRef.current = currentHeight;
      return MIN_DURATION;
    }

    const heightDifference = Math.abs(currentHeight - previousHeight);
    previousHeightRef.current = currentHeight;

    const duration = Math.min(Math.max(heightDifference / 500, MIN_DURATION), MAX_DURATION);

    return duration;
  }, [bounds.height]);

  const handleViewChange = (newView: string) => {
    setView(newView);
    onViewChange?.(newView);
  };

  // Use custom views if provided, otherwise pass undefined
  const views = customViews && Object.keys(customViews).length > 0 ? customViews : undefined;

  const contextValue: FamilyDrawerContextValue = {
    isOpen,
    view,
    setView: handleViewChange,
    opacityDuration,
    elementRef,
    bounds,
    views,
  };

  return (
    <FamilyDrawerContext.Provider value={contextValue}>
      <Drawer.Root open={isOpen} onOpenChange={setIsOpen}>
        {children}
      </Drawer.Root>
    </FamilyDrawerContext.Provider>
  );
}

// ============================================================================
// Trigger Component
// ============================================================================

interface FamilyDrawerTriggerProps {
  children: ReactNode;
  asChild?: boolean;
  className?: string;
}

function FamilyDrawerTrigger({ children, asChild = false, className }: FamilyDrawerTriggerProps) {
  if (asChild) {
    return <Drawer.Trigger asChild>{children}</Drawer.Trigger>;
  }

  return (
    <Drawer.Trigger
      className={clsx(
        "fixed top-1/2 left-1/2 h-10 -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-lg border bg-background px-3.5 py-2 font-medium text-foreground antialiased transition-colors hover:bg-muted/60 focus-visible:shadow-focus-ring-button md:font-medium",
        className,
      )}
      type="button"
    >
      {children}
    </Drawer.Trigger>
  );
}

// ============================================================================
// Portal Component
// ============================================================================

function FamilyDrawerPortal({ children }: { children: ReactNode }) {
  return <Drawer.Portal>{children}</Drawer.Portal>;
}

// ============================================================================
// Overlay Component
// ============================================================================

interface FamilyDrawerOverlayProps {
  className?: string;
  onClick?: () => void;
}

function FamilyDrawerOverlay({ className, onClick }: FamilyDrawerOverlayProps) {
  const { setView } = useFamilyDrawer();

  return (
    <Drawer.Overlay
      className={clsx("fixed inset-0 z-10 bg-black/30", className)}
      onClick={onClick || (() => setView("default"))}
    />
  );
}

// ============================================================================
// Content Component
// ============================================================================

interface FamilyDrawerContentProps {
  children: ReactNode;
  className?: string;
  asChild?: boolean;
}

function FamilyDrawerContent({ children, className, asChild = false }: FamilyDrawerContentProps) {
  const { bounds } = useFamilyDrawer();

  const content = (
    <motion.div
      animate={{
        height: bounds.height,
        transition: {
          duration: 0.27,
          ease: [0.25, 1, 0.5, 1],
        },
      }}
    >
      {children}
    </motion.div>
  );

  if (asChild) {
    return (
      <Drawer.Content
        asChild
        className={clsx(
          "fixed inset-x-4 bottom-4 z-20 mx-auto max-w-[380px] overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-none [--initial-transform:calc(100%+1.25rem)] md:mx-auto md:w-full",
          className,
        )}
      >
        {content}
      </Drawer.Content>
    );
  }

  return (
    <Drawer.Content
      className={clsx(
        "fixed inset-x-4 bottom-4 z-20 mx-auto max-w-[380px] overflow-hidden rounded-xl border border-border bg-background shadow-2xl outline-none [--initial-transform:calc(100%+1.25rem)] md:mx-auto md:w-full",
        className,
      )}
    >
      {content}
    </Drawer.Content>
  );
}

// ============================================================================
// Animated Wrapper Component
// ============================================================================

interface FamilyDrawerAnimatedWrapperProps {
  children: ReactNode;
  className?: string;
}

function FamilyDrawerAnimatedWrapper({ children, className }: FamilyDrawerAnimatedWrapperProps) {
  const { elementRef } = useFamilyDrawer();

  return (
    <div ref={elementRef} className={clsx("px-5 pt-3 pb-6 antialiased", className)}>
      {children}
    </div>
  );
}

// ============================================================================
// Animated Content Component
// ============================================================================

interface FamilyDrawerAnimatedContentProps {
  children: ReactNode;
}

function FamilyDrawerAnimatedContent({ children }: FamilyDrawerAnimatedContentProps) {
  const { view, opacityDuration } = useFamilyDrawer();

  return (
    <AnimatePresence initial={false} mode="popLayout" custom={view}>
      <motion.div
        initial={{ opacity: 0, scale: 0.985, filter: "blur(3px)" }}
        animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, scale: 0.985, filter: "blur(3px)" }}
        key={view}
        transition={{
          duration: opacityDuration,
          ease: [0.26, 0.08, 0.25, 1],
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

// ============================================================================
// Close Component
// ============================================================================

interface FamilyDrawerCloseProps {
  children?: ReactNode;
  asChild?: boolean;
  className?: string;
}

function FamilyDrawerClose({ children, asChild = false, className }: FamilyDrawerCloseProps) {
  if (asChild) {
    return <Drawer.Close asChild>{children}</Drawer.Close>;
  }

  return (
    <Drawer.Close asChild>
      <button
        data-vaul-no-drag=""
        className={clsx(
          "absolute top-4 right-4 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md bg-muted text-muted-foreground transition-transform focus:scale-95 focus-visible:shadow-focus-ring-button active:scale-75",
          className,
        )}
        type="button"
      >
        {children || <CloseIcon />}
      </button>
    </Drawer.Close>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

interface FamilyDrawerHeaderProps {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
}

function FamilyDrawerHeader({ icon, title, description, className }: FamilyDrawerHeaderProps) {
  return (
    <header className={clsx("mt-2 pr-8", className)}>
      {icon}
      <h2 className="mt-2 text-xl font-semibold text-foreground md:font-medium">{title}</h2>
      <p className="mt-2 text-base font-medium leading-6 text-muted-foreground md:font-normal">
        {description}
      </p>
    </header>
  );
}

interface FamilyDrawerButtonProps {
  children: ReactNode;
  onClick: () => void;
  className?: string;
  asChild?: boolean;
}

function FamilyDrawerButton({
  children,
  onClick,
  className,
  asChild = false,
}: FamilyDrawerButtonProps) {
  const button = (
    <button
      data-vaul-no-drag=""
      className={clsx(
        "flex h-11 w-full cursor-pointer items-center gap-3 rounded-lg bg-muted px-3.5 text-base font-semibold text-foreground transition-transform focus:scale-95 focus-visible:shadow-focus-ring-button active:scale-95 md:font-medium",
        className,
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );

  if (asChild) {
    return <Slot>{button}</Slot>;
  }

  return button;
}

interface FamilyDrawerSecondaryButtonProps {
  children: ReactNode;
  onClick: () => void;
  className: string;
  asChild?: boolean;
}

function FamilyDrawerSecondaryButton({
  children,
  onClick,
  className,
  asChild = false,
}: FamilyDrawerSecondaryButtonProps) {
  const button = (
    <button
      data-vaul-no-drag=""
      type="button"
      className={clsx(
        "flex h-11 w-full cursor-pointer items-center justify-center gap-3 rounded-lg text-center text-base font-semibold transition-transform focus:scale-95 focus-visible:shadow-focus-ring-button active:scale-95 md:font-medium",
        className,
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );

  if (asChild) {
    return <Slot>{button}</Slot>;
  }

  return button;
}

// ============================================================================
// View Content Renderer
// ============================================================================

interface FamilyDrawerViewContentProps {
  views?: ViewsRegistry;
}

function FamilyDrawerViewContent(
  { views: propViews }: FamilyDrawerViewContentProps = {} as FamilyDrawerViewContentProps,
) {
  const { view, views: contextViews } = useFamilyDrawer();

  // Use prop views first, then context views
  const views = propViews || contextViews;

  if (!views) {
    throw new Error(
      "FamilyDrawerViewContent requires views to be provided via props or FamilyDrawerRoot",
    );
  }

  const ViewComponent = views[view];

  if (!ViewComponent) {
    // Fallback to default view if view not found
    const DefaultComponent = views.default;
    return DefaultComponent ? <DefaultComponent /> : null;
  }

  return <ViewComponent />;
}

// ============================================================================
// Icons
// ============================================================================

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
      <title>Close Icon</title>
      <path
        d="M10.4854 1.99998L2.00007 10.4853"
        stroke="#999999"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.4854 10.4844L2.00007 1.99908"
        stroke="#999999"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ============================================================================
// Exports
// ============================================================================

export {
  FamilyDrawerAnimatedContent,
  FamilyDrawerAnimatedWrapper,
  FamilyDrawerButton,
  FamilyDrawerClose,
  FamilyDrawerContent,
  FamilyDrawerHeader,
  FamilyDrawerOverlay,
  FamilyDrawerPortal,
  FamilyDrawerRoot,
  FamilyDrawerSecondaryButton,
  FamilyDrawerTrigger,
  FamilyDrawerViewContent,
  useFamilyDrawer,
  type ViewComponent,
  type ViewsRegistry,
};
