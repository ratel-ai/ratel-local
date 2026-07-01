import { useVirtualizer } from "@tanstack/react-virtual";
import { SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRatelApp } from "@/App";
import { type SkillSource, SourceIcon } from "@/components/source-icon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { SkillSummary } from "@/lib/skills";
import { cn } from "@/lib/utils";

interface ImportSkillsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The unmanaged skills available to manage through Ratel. */
  available: SkillSummary[];
  /** Restrict the list to one agent's skills (Agent Setup). Omit to list all. */
  source?: SkillSource;
  /** Called after successful activation so the caller can refresh its lists. */
  onImported: () => void | Promise<void>;
}

/** A skill name can live in both Claude Code and Codex, so a row is keyed by source. */
export function skillKey(skill: SkillSummary): string {
  return `${skill.source}:${skill.id}`;
}

const INITIAL_SKILL_LIMIT = 30;
const LOAD_MORE_SKILL_COUNT = 30;

interface ActivateSkillsResponse {
  skipped?: Array<{ id: string; reason: string }>;
}

/**
 * Manage unmanaged Claude Code / Codex skills through Ratel. A single screen:
 * pick skills, then activate. There is no conflict step — a name
 * already managed by Ratel is excluded from `available` upstream — so unlike the
 * MCP import this stays a simple checkbox list.
 */
export function ImportSkillsDialog(props: ImportSkillsDialogProps) {
  const { request, runAction, busy } = useRatelApp();
  const skills = props.source
    ? props.available.filter((skill) => skill.source === props.source)
    : props.available;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Start each session with a clean slate; the user opts in per skill (or all).
  useEffect(() => {
    if (props.open) {
      setSelected(new Set());
    }
  }, [props.open]);

  const chosen = skills.filter((skill) => selected.has(skillKey(skill)));

  const toggle = (skill: SkillSummary) => {
    setSelected((current) => {
      const next = new Set(current);
      const key = skillKey(skill);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = (items: SkillSummary[], shouldSelect: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const skill of items) {
        const key = skillKey(skill);
        if (shouldSelect) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  const submit = async () => {
    if (chosen.length === 0) return;
    // `activate` takes a single `source` to disambiguate a name present in both
    // agents, so activate each source group separately.
    const idsBySource = new Map<SkillSource, string[]>();
    for (const skill of chosen) {
      const ids = idsBySource.get(skill.source) ?? [];
      ids.push(skill.id);
      idsBySource.set(skill.source, ids);
    }
    const label = `Now managing ${chosen.length} skill${chosen.length === 1 ? "" : "s"}`;
    const ok = await runAction(label, async () => {
      for (const [source, ids] of idsBySource) {
        const result = await request<ActivateSkillsResponse>("/api/skills/activate", {
          method: "POST",
          body: { ids, source },
        });
        if (result.skipped && result.skipped.length > 0) {
          throw new Error(skippedSkillsMessage(result.skipped));
        }
      }
    });
    if (ok) {
      props.onOpenChange(false);
      await props.onImported();
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage skills</DialogTitle>
          <DialogDescription>
            Link skills from Claude Code and Codex into Ratel as invoke-only. The native folders
            stay in place, and the gateway serves them on demand.
          </DialogDescription>
        </DialogHeader>

        {skills.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No external skills to manage.
          </p>
        ) : (
          <SkillImportPicker
            onToggle={toggle}
            onToggleAll={toggleAll}
            resetKey={`${props.open}:${skills.length}`}
            selected={selected}
            skills={skills}
          />
        )}

        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button disabled={busy || chosen.length === 0} onClick={() => void submit()} size="sm">
            {chosen.length > 0 ? `Manage ${chosen.length}` : "Manage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function skippedSkillsMessage(skipped: Array<{ id: string; reason: string }>): string {
  const details = skipped.map((s) => `${s.id}: ${s.reason}`).join("; ");
  return `Could not manage selected skill${skipped.length === 1 ? "" : "s"} (${details})`;
}

export function SkillImportPicker(props: {
  className?: string;
  emptyLabel?: string;
  onToggle: (skill: SkillSummary) => void;
  onToggleAll: (skills: SkillSummary[], shouldSelect: boolean) => void;
  resetKey?: string;
  selected: Set<string>;
  skills: SkillSummary[];
}) {
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_SKILL_LIMIT);
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!normalizedQuery) return props.skills;
    return props.skills.filter((skill) => {
      const haystack = [skill.name, skill.id, skill.description, ...skill.tags]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, props.skills]);
  const loaded = filtered.slice(0, visibleLimit);
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((skill) => props.selected.has(skillKey(skill)));
  const selectedCount = filtered.filter((skill) => props.selected.has(skillKey(skill))).length;
  const canLoadMore = loaded.length < filtered.length;

  const rowVirtualizer = useVirtualizer({
    count: loaded.length,
    estimateSize: () => 86,
    getScrollElement: () => scrollRef.current,
    overscan: 6,
  });

  const updateQuery = (value: string) => {
    setQuery(value);
    setVisibleLimit(INITIAL_SKILL_LIMIT);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  useEffect(() => {
    if (props.resetKey === undefined) return;
    setQuery("");
    setVisibleLimit(INITIAL_SKILL_LIMIT);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [props.resetKey]);

  const maybeLoadMore = () => {
    const el = scrollRef.current;
    if (!el || !canLoadMore) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 160) {
      setVisibleLimit((current) => Math.min(filtered.length, current + LOAD_MORE_SKILL_COUNT));
    }
  };

  return (
    <div className={cn("grid min-w-0 gap-2", props.className)}>
      <div className="relative">
        <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          onChange={(event) => updateQuery(event.target.value)}
          placeholder="Search skills"
          value={query}
        />
      </div>
      <button
        className="flex items-center gap-2 px-1 text-left text-muted-foreground text-xs hover:text-foreground"
        disabled={filtered.length === 0}
        onClick={() => props.onToggleAll(filtered, !allFilteredSelected)}
        type="button"
      >
        <Checkbox checked={allFilteredSelected} className="pointer-events-none" tabIndex={-1} />
        {allFilteredSelected ? "Deselect matching" : "Select matching"} ({filtered.length})
        {selectedCount > 0 ? <span className="ml-auto">{selectedCount} selected</span> : null}
      </button>
      {filtered.length === 0 ? (
        <p className="rounded-md border border-border px-3 py-6 text-center text-muted-foreground text-sm">
          {props.emptyLabel ?? "No matching skills."}
        </p>
      ) : (
        <div
          data-skill-scroll
          className="max-h-[55vh] min-h-52 overflow-auto rounded-md border border-border bg-background"
          onScroll={maybeLoadMore}
          ref={scrollRef}
        >
          <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const skill = loaded[virtualRow.index];
              if (!skill) return null;
              const isSelected = props.selected.has(skillKey(skill));
              return (
                <div
                  data-index={virtualRow.index}
                  key={skillKey(skill)}
                  ref={rowVirtualizer.measureElement}
                  className="absolute top-0 left-0 w-full px-2 py-1"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <button
                    className={cn(
                      "flex w-full min-w-0 items-start gap-3 rounded-md border p-3 text-left transition-colors",
                      isSelected
                        ? "border-brand-green bg-brand-green/10"
                        : "border-border bg-card hover:bg-muted/35",
                    )}
                    onClick={() => props.onToggle(skill)}
                    type="button"
                  >
                    <Checkbox
                      checked={isSelected}
                      className="pointer-events-none mt-0.5"
                      tabIndex={-1}
                    />
                    <SourceIcon className="mt-0.5" source={skill.source} />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate font-medium">{skill.name}</strong>
                      {skill.description && (
                        <span className="mt-0.5 line-clamp-2 break-words text-muted-foreground text-sm">
                          {skill.description}
                        </span>
                      )}
                      {skill.tags.length > 0 ? (
                        <span className="mt-2 flex flex-wrap gap-1">
                          {skill.tags.slice(0, 4).map((tag) => (
                            <span
                              className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
                              key={tag}
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {canLoadMore ? (
            <div className="border-border border-t px-3 py-2 text-center text-muted-foreground text-xs">
              Scroll to load more ({loaded.length} of {filtered.length})
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
