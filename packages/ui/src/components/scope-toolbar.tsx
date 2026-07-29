import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type ScopeToolbarOption<T extends string> = {
  label: ReactNode;
  value: T;
};

interface ScopeToolbarProps<T extends string> {
  ariaLabel: string;
  controls?: ReactNode;
  metadataPrimary: ReactNode;
  metadataSecondary?: ReactNode;
  onValueChange: (value: T) => void;
  options: readonly ScopeToolbarOption<T>[];
  value: T;
}

function ScopeToolbar<T extends string>({
  ariaLabel,
  controls,
  metadataPrimary,
  metadataSecondary,
  onValueChange,
  options,
  value,
}: ScopeToolbarProps<T>) {
  if (options.length === 0) return null;

  return (
    <section
      className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40"
      data-slot="scope-toolbar"
    >
      <div className="flex flex-col gap-3 px-4 pt-3 sm:px-5 lg:flex-row lg:items-end lg:justify-between">
        <Tabs
          className="min-w-0 gap-0"
          onValueChange={(nextValue) => onValueChange(nextValue as T)}
          value={value}
        >
          <TabsList aria-label={ariaLabel} className="w-full lg:w-fit" variant="line">
            {options.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {controls != null ? (
          <div className="pb-3 lg:w-fit lg:pb-2" data-slot="scope-toolbar-controls">
            {controls}
          </div>
        ) : null}
      </div>
      <div
        className="grid gap-1 border-forest-300 border-t bg-background/20 px-4 py-3 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-6"
        data-slot="scope-toolbar-metadata"
      >
        <div className="min-w-0" data-slot="scope-toolbar-metadata-primary">
          {metadataPrimary}
        </div>
        {metadataSecondary != null ? (
          <div className="min-w-0 lg:text-right" data-slot="scope-toolbar-metadata-secondary">
            {metadataSecondary}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export { ScopeToolbar };
