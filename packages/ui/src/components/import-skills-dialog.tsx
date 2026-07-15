import { useEffect, useState } from "react";
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
import type { SkillSummary } from "@/lib/skills";

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
function skillKey(skill: SkillSummary): string {
  return `${skill.source}:${skill.id}`;
}

/** Rows per page; long skill lists page rather than scroll forever. */
const PAGE_SIZE = 6;

interface ActivateSkillsResponse {
  managed: Array<{ id: string; mode: string }>;
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
  const [page, setPage] = useState(0);

  // Start each session with a clean slate; the user opts in per skill (or all).
  useEffect(() => {
    if (props.open) {
      setSelected(new Set());
      setPage(0);
    }
  }, [props.open]);

  const chosen = skills.filter((skill) => selected.has(skillKey(skill)));
  const allSelected = skills.length > 0 && chosen.length === skills.length;
  const pageCount = Math.max(1, Math.ceil(skills.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageStart = safePage * PAGE_SIZE;
  const visible = skills.slice(pageStart, pageStart + PAGE_SIZE);

  const toggle = (skill: SkillSummary) => {
    setSelected((current) => {
      const next = new Set(current);
      const key = skillKey(skill);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(skills.map(skillKey)));
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
    const managed: ActivateSkillsResponse["managed"] = [];
    const skipped: NonNullable<ActivateSkillsResponse["skipped"]> = [];
    const ok = await runAction("Skill management complete", async () => {
      for (const [source, ids] of idsBySource) {
        const result = await request<ActivateSkillsResponse>("/api/skills/activate", {
          method: "POST",
          body: { ids, source },
        });
        managed.push(...result.managed);
        skipped.push(...(result.skipped ?? []));
      }
      if (managed.length === 0 && skipped.length > 0)
        throw new Error(skippedSkillsMessage(skipped));
      return {
        log: [
          `Now managing ${managed.length} skill${managed.length === 1 ? "" : "s"}`,
          ...(skipped.length > 0 ? [skippedSkillsMessage(skipped)] : []),
        ],
      };
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
          <div className="grid gap-2">
            <button
              className="flex items-center gap-2 px-1 text-left text-muted-foreground text-xs hover:text-foreground"
              onClick={toggleAll}
              type="button"
            >
              <Checkbox checked={allSelected} className="pointer-events-none" tabIndex={-1} />
              {allSelected ? "Deselect all" : "Select all"} ({skills.length})
            </button>
            <ul className="grid max-h-[55vh] gap-2 overflow-y-auto pr-1">
              {visible.map((skill) => {
                const isSelected = selected.has(skillKey(skill));
                return (
                  <li key={skillKey(skill)}>
                    <button
                      className={`flex w-full min-w-0 items-start gap-3 rounded-md border p-3 text-left transition-colors ${
                        isSelected
                          ? "border-brand-green bg-brand-green/10"
                          : "border-border bg-card hover:bg-muted/35"
                      }`}
                      onClick={() => toggle(skill)}
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
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {pageCount > 1 && (
              <div className="flex items-center justify-between px-1 text-muted-foreground text-xs">
                <span>
                  {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, skills.length)} of{" "}
                  {skills.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={safePage === 0}
                    onClick={() => setPage(safePage - 1)}
                    size="sm"
                    variant="outline"
                  >
                    Prev
                  </Button>
                  <span>
                    {safePage + 1} / {pageCount}
                  </span>
                  <Button
                    disabled={safePage >= pageCount - 1}
                    onClick={() => setPage(safePage + 1)}
                    size="sm"
                    variant="outline"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
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
