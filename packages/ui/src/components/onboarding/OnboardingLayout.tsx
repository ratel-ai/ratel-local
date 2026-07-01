import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Bare, standalone chrome for the onboarding flow: a slim top row (brand · step dots ·
 * Skip) over a centered content column. Rendered outside the app header/nav rail so the
 * wizard feels like a dedicated first-run experience.
 */
export function OnboardingLayout(props: {
  children: ReactNode;
  onSkip?: () => void;
  progress?: { current: number; total: number };
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 px-4 sm:px-6">
        <BrandLogo />
        {props.progress ? (
          <StepDots current={props.progress.current} total={props.progress.total} />
        ) : null}
        {props.onSkip ? (
          <Button
            className="text-muted-foreground"
            onClick={props.onSkip}
            size="sm"
            type="button"
            variant="ghost"
          >
            Skip
          </Button>
        ) : (
          <span aria-hidden className="w-12" />
        )}
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16 sm:px-6">
        <div className="w-full max-w-2xl">{props.children}</div>
      </main>
    </div>
  );
}

/** Heading for a wizard step: optional icon, an optional uppercase kicker, title, blurb. */
export function StepHeading(props: {
  description?: string;
  icon?: ReactNode;
  kicker?: string;
  title: string;
}) {
  return (
    <div className="grid gap-2">
      {props.icon ? <div className="mb-2 flex">{props.icon}</div> : null}
      {props.kicker ? (
        <span className="font-mono text-muted-foreground text-xs uppercase tracking-wide">
          {props.kicker}
        </span>
      ) : null}
      <h1 className="font-semibold text-2xl tracking-tight">{props.title}</h1>
      {props.description ? (
        <p className="text-muted-foreground text-sm">{props.description}</p>
      ) : null}
    </div>
  );
}

/** Back (ghost, left) + a caller-supplied primary action (right). */
export function StepFooter(props: { onBack: () => void; primary: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button onClick={props.onBack} type="button" variant="ghost">
        <ArrowLeft />
        Back
      </Button>
      {props.primary}
    </div>
  );
}

function StepDots(props: { current: number; total: number }) {
  return (
    <div aria-hidden className="flex items-center gap-2">
      {Array.from({ length: props.total }, (_, index) => (
        <span
          className={cn(
            "size-1.5 rounded-full transition-colors",
            index <= props.current ? "bg-foreground" : "bg-muted-foreground/30",
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static indicator
          key={index}
        />
      ))}
    </div>
  );
}
