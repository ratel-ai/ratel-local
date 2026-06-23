import { useEffect, useRef, useState } from "react";
import { PrismSweep } from "@/components/ui/prism-sweep";
import type { IntentRecord } from "@/lib/intents";
import { cn } from "@/lib/utils";

/** Row enter animation duration; the "new" flag is cleared just after it finishes. */
const ENTER_MS = 520;
/** Searching placeholder collapse duration; keep it mounted until the exit plays out. */
export const PLACEHOLDER_EXIT_MS = 320;

/**
 * Pure core of {@link useStreamingOrder}'s ordering: survivors keep their prior
 * relative slot (so nothing reshuffles under the user mid-run), and brand-new contents
 * are prepended at the TOP so results stream in from the top. A content that has gone
 * away is dropped. Returns the next order and the new contents (the ones to animate in).
 */
export function reconcileStreamOrder(
  prevOrder: readonly string[],
  incoming: readonly string[],
): { order: string[]; added: string[] } {
  const incomingSet = new Set(incoming);
  const kept = prevOrder.filter((content) => incomingSet.has(content));
  const keptSet = new Set(kept);
  const added = incoming.filter((content) => !keptSet.has(content));
  return { order: [...added, ...kept], added };
}

/**
 * Keep a list of intents in a STABLE display order while results stream in during a
 * run: survivors stay put, newcomers append at the end, and each newcomer is flagged
 * `entering` just long enough to play its grow-in animation once. Without streaming the
 * first render adopts the server order silently — a plain page load shouldn't animate
 * the whole list.
 */
export function useStreamingOrder(
  intents: IntentRecord[],
  streaming: boolean,
): { items: IntentRecord[]; entering: ReadonlySet<string> } {
  const [order, setOrder] = useState<string[]>([]);
  const [entering, setEntering] = useState<ReadonlySet<string>>(() => new Set());
  // Mirror of `order` for synchronous reconciliation; `seeded` distinguishes a fresh
  // load from a streamed update so a plain load doesn't animate everything.
  const orderRef = useRef<string[]>([]);
  const seeded = useRef(false);
  const timers = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const incoming = intents.map((i) => i.content);
    const { order: nextOrder, added: newcomers } = reconcileStreamOrder(orderRef.current, incoming);
    orderRef.current = nextOrder;
    setOrder(nextOrder);

    const firstSnapshot = !seeded.current;
    seeded.current = true;
    // On a plain (non-streaming) first load, don't animate the existing list in.
    const added = firstSnapshot && !streaming ? [] : newcomers;
    if (added.length === 0) return;

    setEntering((prev) => {
      const next = new Set(prev);
      for (const content of added) next.add(content);
      return next;
    });
    // Drop each flag once the animation has played so a later re-render can't replay it.
    for (const content of added) {
      const existing = timers.current.get(content);
      if (existing) window.clearTimeout(existing);
      const id = window.setTimeout(() => {
        timers.current.delete(content);
        setEntering((prev) => {
          if (!prev.has(content)) return prev;
          const next = new Set(prev);
          next.delete(content);
          return next;
        });
      }, ENTER_MS);
      timers.current.set(content, id);
    }
  }, [intents, streaming]);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const id of map.values()) window.clearTimeout(id);
    };
  }, []);

  const byContent = new Map(intents.map((i) => [i.content, i]));
  const items: IntentRecord[] = [];
  for (const content of order) {
    const record = byContent.get(content);
    if (record) items.push(record);
  }
  return { items, entering };
}

/**
 * Keep a soon-to-unmount element alive through its exit animation: it stays `mounted`
 * for `exitMs` after `active` flips false (so a closing animation can play), reporting
 * `exiting` in the meantime.
 */
export function usePresence(
  active: boolean,
  exitMs: number,
): { mounted: boolean; exiting: boolean } {
  const [mounted, setMounted] = useState(active);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (active) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const id = window.setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, exitMs);
    return () => window.clearTimeout(id);
  }, [active, mounted, exitMs]);

  return { mounted, exiting };
}

/**
 * The "slot" where the next intent will land: a dashed skeleton row with a small pixel
 * loader, shown at the foot of the list while a run streams results in. It grows in on
 * mount and collapses out (rather than blinking away) when the run ends.
 */
export function IntentSearchingRow({ exiting }: { exiting: boolean }) {
  return (
    <li
      aria-hidden
      className={cn("grid", exiting ? "animate-intent-collapse" : "animate-intent-enter")}
    >
      <div className="overflow-hidden">
        <div className="flex items-center gap-3 rounded-md border border-border border-dashed bg-muted/20 p-3">
          <PrismSweep dotSize={3} size={22} speed={1.3} />
          <div className="min-w-0 flex-1">
            <div className="h-3 w-2/5 animate-pulse rounded-[2px] bg-muted-foreground/15" />
            <div className="mt-2 h-2.5 w-1/4 animate-pulse rounded-[2px] bg-muted-foreground/10" />
          </div>
          <span className="shrink-0 text-muted-foreground text-xs">Searching for intents…</span>
        </div>
      </div>
    </li>
  );
}
