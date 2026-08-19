import { Kbd } from "@/components/ui/kbd";
import { currentShortcutPlatform, formatShortcutChord } from "@/lib/keyboard-shortcuts";
import { cn } from "@/lib/utils";

export function ShortcutHint({
  className,
  keyClassName,
  shortcut,
}: {
  className?: string;
  keyClassName?: string;
  shortcut: string;
}) {
  const platform = currentShortcutPlatform();
  const label = formatShortcutChord(shortcut, platform);

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex items-center gap-1", className)}
      title={`Shortcut: ${label}`}
    >
      <Kbd className={cn("bg-muted/70 text-foreground/75", keyClassName)}>{label}</Kbd>
    </span>
  );
}
