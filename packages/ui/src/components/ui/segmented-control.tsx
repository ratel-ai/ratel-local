import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

export type Segment<T extends string> = { label: string; value: T };

function SegmentedControl<T extends string>({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel?: string;
  className?: string;
  onChange: (value: T) => void;
  options: readonly Segment<T>[];
  value: T;
}) {
  if (options.length === 0) return null;

  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <TabsPrimitive.Root
      className={cn("inline-flex", className)}
      onValueChange={(nextValue) => onChange(nextValue as T)}
      value={value}
    >
      <TabsPrimitive.List
        aria-label={ariaLabel}
        className="relative inline-grid rounded-full border border-forest-300 bg-base-deep/50 p-0.5"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        <span
          aria-hidden
          className="absolute top-0.5 bottom-0.5 left-0.5 rounded-full bg-cream shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{
            transform: `translateX(${index * 100}%)`,
            width: `calc((100% - 4px) / ${options.length})`,
          }}
        />
        {options.map((option) => (
          <TabsPrimitive.Tab
            className="relative z-10 rounded-full px-3.5 py-1.5 text-center text-sm font-medium whitespace-nowrap text-warm-muted transition-colors duration-200 hover:text-cream focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/60 data-active:text-ink"
            key={option.value}
            value={option.value}
          >
            {option.label}
          </TabsPrimitive.Tab>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export { SegmentedControl };
