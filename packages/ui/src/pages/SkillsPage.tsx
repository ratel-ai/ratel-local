import { useNavigate } from "@tanstack/react-router";
import { Download, Sparkles, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { skillPath, useRatelApp } from "@/App";
import { ImportSkillsDialog } from "@/components/import-skills-dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
import { ShareBar, sharePercent } from "@/components/share-bar";
import { type SkillSource, SourceIcon, sourceLabel } from "@/components/source-icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SkillSummary, SkillsResponse } from "@/lib/skills";
import { cn } from "@/lib/utils";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillsResponse };

export function SkillsPage() {
  const { request, runAction, busy, token } = useRatelApp();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [importOpen, setImportOpen] = useState(false);

  const openSkill = (id: string) => {
    void navigate({ to: skillPath(id, token) } as never);
  };

  const load = useCallback(async () => {
    try {
      const data = await request<SkillsResponse>("/api/skills");
      setState({ status: "ready", data });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to load skills",
      });
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (label: string, path: string, body?: Record<string, unknown>) => {
      // Discard the response body so runAction's toast shows just `label`, not the
      // operation's per-skill log lines (which are noise for a human).
      const okResult = await runAction(label, () =>
        request(path, { method: "POST", body: body ?? {} }).then(() => undefined),
      );
      if (okResult) await load();
    },
    [runAction, request, load],
  );

  const ready = state.status === "ready" ? state.data : null;
  // Default the buckets defensively: if the API ever returns an unexpected shape
  // (e.g. a stale server mid-deploy), render an empty page instead of crashing.
  const managed = ready?.managed ?? [];
  const available = ready?.available ?? [];
  const problems = ready?.problems ?? [];
  const canImport = available.length > 0;
  const canDeactivateAll = managed.length > 0;

  return (
    <main className="flex w-full flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Skills</PageHeaderTitle>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Reusable playbooks Ratel manages and serves through the gateway. Import skills from
            Claude Code or Codex to manage them here; stop managing one to return it to where it
            came from.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden items-center sm:flex">
          <NewSkillDialog onCreated={load} />
          {canImport && (
            <Button
              className="h-10"
              onClick={() => setImportOpen(true)}
              size="sm"
              variant="outline"
            >
              <Download />
              Import skills
            </Button>
          )}
          {canDeactivateAll && (
            <Button
              className="h-10"
              disabled={busy}
              onClick={() =>
                void mutate(
                  `Stopped managing ${managed.length} skill${managed.length === 1 ? "" : "s"}`,
                  "/api/skills/deactivate",
                )
              }
              size="sm"
              variant="outline"
            >
              Unmanage all
            </Button>
          )}
        </PageHeaderActions>
      </PageHeader>

      {state.status === "loading" && (
        <p className="px-1 text-muted-foreground text-sm">Loading skills…</p>
      )}

      {state.status === "error" && (
        <EmptyState title="Couldn't load skills" description={state.message}>
          <Button onClick={() => void load()} size="sm" variant="outline">
            Retry
          </Button>
        </EmptyState>
      )}

      {problems.length > 0 && (
        <section className="-mx-4 border-amber-500/30 border-y bg-amber-500/10 px-4 py-3 sm:-mx-6 sm:px-6">
          <div className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <h3 className="font-medium text-sm">
                {problems.length} skill{problems.length === 1 ? "" : "s"} couldn't be loaded
              </h3>
              <ul className="mt-1 grid gap-1">
                {problems.map((p) => (
                  <li className="text-muted-foreground text-xs" key={`${p.where}:${p.id}`}>
                    <code className="font-mono">{p.id}</code> ({p.where}): {p.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {ready && managed.length === 0 && available.length > 0 && (
        <EmptyState
          title="No skills managed by Ratel yet"
          description="Import skills from Claude Code or Codex to serve them through the gateway."
        >
          <Button onClick={() => setImportOpen(true)} size="sm">
            <Download />
            Import skills
          </Button>
        </EmptyState>
      )}

      {ready && managed.length === 0 && available.length === 0 && (
        <EmptyState
          title="No skills managed by Ratel yet"
          description="Add skills under ~/.claude/skills (Claude Code) or ~/.codex/skills (Codex), or create one in Ratel, then import them here."
        />
      )}

      {ready && managed.length > 0 && (
        <SkillSection
          title="Managed by Ratel"
          caption="Served through the gateway. Stop managing one to return it to its agent."
          onView={openSkill}
          skills={managed}
          renderAction={(skill) =>
            skill.source === "ratel" ? (
              <span className="px-1 text-muted-foreground text-xs">Created in Ratel</span>
            ) : (
              <Button
                disabled={busy}
                onClick={() =>
                  void mutate(`Stopped managing ${skill.name}`, "/api/skills/deactivate", {
                    ids: [skill.id],
                  })
                }
                size="sm"
                variant="outline"
              >
                Stop managing
              </Button>
            )
          }
        />
      )}

      <ImportSkillsDialog
        available={available}
        onImported={load}
        onOpenChange={setImportOpen}
        open={importOpen}
      />
    </main>
  );
}

const PAGE_SIZE = 8;
const SKILL_ROW_GRID = "lg:grid-cols-[minmax(14rem,1.25fr)_10rem_minmax(12rem,0.9fr)_11rem_9rem]";
const CODEX_SOURCE_COLOR = "#3941FF";
const CLAUDE_CODE_SOURCE_COLOR = "#D97757";

function SkillSection(props: {
  title: string;
  caption: string;
  skills: SkillSummary[];
  onView: (id: string) => void;
  renderAction: (skill: SkillSummary) => ReactNode;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(props.skills.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const visible = props.skills.slice(start, start + PAGE_SIZE);
  const sourceCounts = countSkillsBySource(props.skills);

  return (
    <section className="grid gap-2">
      <div className="px-1">
        <h2 className="font-medium text-sm">
          {props.title} <span className="text-muted-foreground">({props.skills.length})</span>
        </h2>
        <p className="text-muted-foreground text-xs">{props.caption}</p>
      </div>
      <div className="-mx-4 overflow-hidden border-border border-y sm:-mx-6">
        <div
          className={cn(
            "hidden gap-3 border-border border-b bg-muted/30 px-4 py-2 font-mono text-xs text-muted-foreground uppercase sm:px-6 lg:grid",
            SKILL_ROW_GRID,
          )}
        >
          <span>Skill</span>
          <span>Source</span>
          <span className="text-right">Tags</span>
          <span className="text-right">Source Share</span>
          <span>Action</span>
        </div>
        <div className="divide-border divide-y">
          {visible.map((skill) => (
            <SkillRow
              key={`${skill.source}:${skill.id}`}
              skill={skill}
              sourceCount={sourceCounts[skill.source]}
              totalCount={props.skills.length}
              onView={props.onView}
              renderAction={props.renderAction}
            />
          ))}
        </div>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between px-1 text-muted-foreground text-xs">
          <span>
            {start + 1}–{Math.min(start + PAGE_SIZE, props.skills.length)} of {props.skills.length}
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
    </section>
  );
}

function SkillRow(props: {
  onView: (id: string) => void;
  renderAction: (skill: SkillSummary) => ReactNode;
  skill: SkillSummary;
  sourceCount: number;
  totalCount: number;
}) {
  const color = skillSourceColor(props.skill.source);

  return (
    <div
      className={cn(
        "relative grid gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/30 sm:px-6 lg:grid lg:items-center",
        SKILL_ROW_GRID,
      )}
    >
      <button
        aria-label={`Open ${props.skill.name}`}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
        onClick={() => props.onView(props.skill.id)}
        type="button"
      />
      <div className="relative z-20 grid min-w-0 gap-3 lg:hidden">
        <div className="pointer-events-none flex min-w-0 items-start gap-2">
          <DataSwatch color={color} />
          <div className="min-w-0 flex-1 text-left">
            <strong className="block truncate font-medium hover:underline">
              {props.skill.name}
            </strong>
            {props.skill.description && (
              <p className="mt-1 line-clamp-2 text-muted-foreground">{props.skill.description}</p>
            )}
          </div>
        </div>
        <div className="pointer-events-none grid min-w-0 grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs text-muted-foreground uppercase">Source</span>
          <SkillSourceLabel source={props.skill.source} />
          <span className="font-mono text-xs text-muted-foreground uppercase">Tags</span>
          <div className="min-w-0 text-right">
            <SkillTagLabel tags={props.skill.tags} />
          </div>
          <span className="font-mono text-xs text-muted-foreground uppercase">Share</span>
          <div className="flex min-w-0 items-center justify-end gap-2">
            <SkillShareLabel
              color={color}
              sourceCount={props.sourceCount}
              totalCount={props.totalCount}
            />
          </div>
          <div className="pointer-events-auto relative z-30 col-start-2 flex justify-end">
            {props.renderAction(props.skill)}
          </div>
        </div>
      </div>

      <div className="pointer-events-none relative z-20 hidden min-w-0 lg:block">
        <div className="flex min-w-0 items-center gap-2">
          <DataSwatch color={color} />
          <div className="min-w-0 text-left">
            <strong className="block truncate font-medium hover:underline">
              {props.skill.name}
            </strong>
          </div>
        </div>
        {props.skill.description && (
          <p className="mt-1 line-clamp-2 text-muted-foreground">{props.skill.description}</p>
        )}
      </div>
      <div className="pointer-events-none relative z-20 hidden lg:block">
        <SkillSourceLabel source={props.skill.source} />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 text-right lg:block">
        <SkillTagLabel tags={props.skill.tags} />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 lg:flex lg:items-center lg:justify-end">
        <SkillShareLabel
          color={color}
          sourceCount={props.sourceCount}
          totalCount={props.totalCount}
        />
      </div>
      <div className="relative z-30 hidden lg:flex lg:justify-start">
        {props.renderAction(props.skill)}
      </div>
    </div>
  );
}

function SkillSourceLabel(props: { source: SkillSource }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <SourceIcon source={props.source} />
      <span className="truncate font-medium">{sourceLabel(props.source)}</span>
    </span>
  );
}

function SkillTagLabel(props: { tags: string[] }) {
  if (props.tags.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">0 tags</span>;
  }

  return (
    <div className="grid justify-items-end gap-1">
      <span className="font-mono text-xs">{props.tags.length} tags</span>
      <div className="flex max-w-full flex-wrap justify-end gap-1">
        {props.tags.slice(0, 2).map((tag) => (
          <span
            className="max-w-24 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
            key={tag}
            title={tag}
          >
            {tag}
          </span>
        ))}
        {props.tags.length > 2 && (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
            +{props.tags.length - 2}
          </span>
        )}
      </div>
    </div>
  );
}

function SkillShareLabel(props: { color: string; sourceCount: number; totalCount: number }) {
  return (
    <div className="flex items-center justify-end gap-3">
      <ShareBar color={props.color} total={props.totalCount} value={props.sourceCount} />
      <span className="w-9 text-right font-mono text-xs">
        {sharePercent(props.sourceCount, props.totalCount)}%
      </span>
    </div>
  );
}

function DataSwatch(props: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-[3px]"
      style={{ backgroundColor: props.color }}
    />
  );
}

function countSkillsBySource(skills: readonly SkillSummary[]): Record<SkillSource, number> {
  const counts: Record<SkillSource, number> = { claude: 0, codex: 0, ratel: 0 };
  for (const skill of skills) counts[skill.source] += 1;
  return counts;
}

function skillSourceColor(source: SkillSource): string {
  if (source === "claude") return CLAUDE_CODE_SOURCE_COLOR;
  if (source === "codex") return CODEX_SOURCE_COLOR;
  return "var(--color-ctx-skills)";
}

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md gap-3">
        <div className="mx-auto rounded-md bg-muted p-2 text-muted-foreground">
          <Sparkles className="size-5" />
        </div>
        <div>
          <h3 className="font-medium">{props.title}</h3>
          <p className="mt-1 text-muted-foreground text-sm">{props.description}</p>
        </div>
        {props.children && <div>{props.children}</div>}
      </div>
    </section>
  );
}

function NewSkillDialog(props: { onCreated: () => void | Promise<void> }) {
  const { request, runAction, busy } = useRatelApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");

  const reset = () => {
    setName("");
    setDescription("");
    setTags("");
    setBody("");
  };

  const submit = async () => {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const created = await runAction(`Created skill ${name.trim()}`, () =>
      request("/api/skills", {
        method: "POST",
        body: { name: name.trim(), description: description.trim(), tags: tagList, body },
      }),
    );
    if (created) {
      setOpen(false);
      reset();
      await props.onCreated();
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-10" size="sm" />}>New skill</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Writes a SKILL.md into Ratel's managed folder; it's served through the gateway
            immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              value={name}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When the agent should reach for this skill…"
              value={description}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-tags">Tags (comma-separated)</Label>
            <Input
              id="skill-tags"
              onChange={(e) => setTags(e.target.value)}
              placeholder="deploy, ship to production"
              value={tags}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="skill-body">Instructions</Label>
            <Textarea
              className="min-h-32 font-mono text-xs"
              id="skill-body"
              onChange={(e) => setBody(e.target.value)}
              placeholder="# How to…"
              value={body}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button size="sm" variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={busy || name.trim() === "" || description.trim() === ""}
            onClick={() => void submit()}
            size="sm"
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
