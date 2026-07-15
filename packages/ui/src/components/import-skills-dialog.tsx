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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  applySkillImportSelections,
  availableSkillImportScopes,
  buildSkillImportSelections,
  defaultSkillImportTarget,
  type SkillImportMode,
  type SkillImportScope,
  type SkillSummary,
} from "@/lib/skills";
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

/** Import opaque discovery candidates into one explicit Ratel scope and mode. */
export function ImportSkillsDialog(props: ImportSkillsDialogProps) {
  const { context, request, runAction, busy } = useRatelApp();
  const skills = props.source
    ? props.available.filter((skill) => skill.source === props.source)
    : props.available;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const initialTarget = defaultSkillImportTarget(context);
  const [scope, setScope] = useState<SkillImportScope>(initialTarget?.scope ?? "user");
  const [mode, setMode] = useState<SkillImportMode>(initialTarget?.mode ?? "reference");
  const availableScopes = availableSkillImportScopes(context);

  // Start each session with a clean slate; the user opts in per skill (or all).
  useEffect(() => {
    if (props.open) {
      setSelected(new Set());
      const target = defaultSkillImportTarget(context);
      if (target) {
        setScope(target.scope);
        setMode(target.mode);
      }
    }
  }, [context, props.open]);

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
    const label = `Imported ${chosen.length} skill${chosen.length === 1 ? "" : "s"} into ${scope}`;
    const ok = await runAction(label, async () => {
      const selections = buildSkillImportSelections(chosen, context, { scope, mode });
      await applySkillImportSelections(request, selections);
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

        {availableScopes.length > 0 ? (
          <div className="grid gap-3 rounded-md border border-border bg-muted/15 p-3 sm:grid-cols-2">
            <div className="grid gap-1.5 text-sm">
              <span className="font-medium">Target scope</span>
              <Select value={scope} onValueChange={(value) => setScope(value as SkillImportScope)}>
                <SelectTrigger aria-label="Target scope" className="w-full">
                  <SelectValue>{scopeLabel(scope)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {availableScopes.map((candidateScope) => (
                    <SelectItem key={candidateScope} value={candidateScope}>
                      {scopeLabel(candidateScope)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5 text-sm">
              <span className="font-medium">Import mode</span>
              <Select value={mode} onValueChange={(value) => setMode(value as SkillImportMode)}>
                <SelectTrigger aria-label="Import mode" className="w-full">
                  <SelectValue>{mode === "copy" ? "Owned copy" : "Reference"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reference">Reference</SelectItem>
                  <SelectItem value="copy">Owned copy</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <p className="rounded-md border border-border px-3 py-4 text-muted-foreground text-sm">
            Select Global or a project before importing skills. All projects is read-only.
          </p>
        )}

        {skills.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No external skills to manage.
          </p>
        ) : (
          <SkillImportPicker
            title="Skills"
            onToggle={toggle}
            onToggleAll={toggleAll}
            resetKey={`${props.open}:${skills.length}`}
            selected={selected}
            skills={skills}
          />
        )}

        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={busy || chosen.length === 0 || availableScopes.length === 0}
            onClick={() => void submit()}
            size="sm"
          >
            {chosen.length > 0 ? `Manage ${chosen.length}` : "Manage"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function scopeLabel(scope: SkillImportScope): string {
  return scope[0].toUpperCase() + scope.slice(1);
}

export function SkillImportPicker(props: {
  className?: string;
  emptyLabel?: string;
  flushScroll?: boolean;
  onToggle: (skill: SkillSummary) => void;
  onToggleAll: (skills: SkillSummary[], shouldSelect: boolean) => void;
  resetKey?: string;
  selected: Set<string>;
  skills: SkillSummary[];
  title?: string;
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
    <div className={cn("grid min-w-0 gap-3", props.className)}>
      {props.title ? (
        <div className="flex min-w-0 items-center justify-between gap-3 px-1">
          <h4 className="truncate font-medium text-sm">
            {props.title} <span className="text-muted-foreground">({filtered.length})</span>
          </h4>
          <button
            className="shrink-0 text-muted-foreground text-xs transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            disabled={filtered.length === 0}
            onClick={() => props.onToggleAll(filtered, !allFilteredSelected)}
            type="button"
          >
            {allFilteredSelected ? "Deselect all" : "Select all"}
            {selectedCount > 0 ? ` · ${selectedCount}` : ""}
          </button>
        </div>
      ) : null}
      <div className="relative">
        <SearchIcon className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
        <Input
          className="pl-8"
          onChange={(event) => updateQuery(event.target.value)}
          placeholder="Search skills"
          value={query}
        />
      </div>
      {filtered.length === 0 ? (
        <p className="rounded-md border border-border px-3 py-6 text-center text-muted-foreground text-sm">
          {props.emptyLabel ?? "No matching skills."}
        </p>
      ) : (
        <div className={cn("border-border border-t", props.flushScroll && "-mx-4 sm:-mx-5")}>
          <div
            data-skill-scroll
            className="max-h-[55vh] min-h-52 overflow-auto bg-background"
            onScroll={maybeLoadMore}
            ref={scrollRef}
          >
            <div
              className="relative w-full"
              style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const skill = loaded[virtualRow.index];
                if (!skill) return null;
                const isSelected = props.selected.has(skillKey(skill));
                return (
                  <div
                    data-index={virtualRow.index}
                    key={skillKey(skill)}
                    ref={rowVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <button
                      className={cn(
                        "flex w-full min-w-0 items-start gap-3 border-border border-b px-3 py-2 text-left transition-colors",
                        isSelected ? "bg-brand-green/10" : "bg-background hover:bg-muted/35",
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
        </div>
      )}
    </div>
  );
}
