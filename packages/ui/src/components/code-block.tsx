import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function CodeBlock({
  className,
  code,
  label = "Code",
}: {
  className?: string;
  code: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The code remains selectable when clipboard permission is unavailable.
    }
  };

  return (
    <section
      className={cn(
        "overflow-hidden rounded-xl border border-forest-300 bg-base-deep/80",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-forest-300 border-b bg-forest-600/60 px-4 py-2.5">
        <span className="font-mono text-xs text-warm-muted">{label}</span>
        <Button onClick={() => void copy()} size="sm" type="button" variant="outline">
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-[min(70vh,720px)] overflow-auto p-4 font-mono text-xs leading-relaxed text-cream-dim scroll-mask-y scroll-mask-y-from-88% sm:p-6">
        {code}
      </pre>
    </section>
  );
}

export { CodeBlock };
