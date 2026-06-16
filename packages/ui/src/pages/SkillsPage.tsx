import { useNavigate } from "@tanstack/react-router";
import { SearchIcon, Sparkles, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { skillPath, useRatelApp } from "@/App";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
  PageHeaderTitle,
} from "@/components/page-header";
import { ResponsiveToolbar, ResponsiveToolbarButton } from "@/components/responsive-toolbar";
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

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

interface SkillProblem {
  id: string;
  where: string;
  reason: string;
}

interface SkillsResponse {
  managedDir: string;
  nativeDir: string;
  managed: SkillSummary[];
  available: SkillSummary[];
  problems: SkillProblem[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillsResponse };

export function SkillsPage() {
  const { openCommandMenu, request, runAction, busy, token } = useRatelApp();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });

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
    async (label: string, path: string, ids?: string[]) => {
      // Discard the response body so runAction's toast shows just `label`, not the
      // operation's per-skill log lines (which are noise for a human).
      const okResult = await runAction(label, () =>
        request(path, { method: "POST", body: ids ? { ids } : {} }).then(() => undefined),
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
  const canActivateAll = available.length > 0;
  const canDeactivateAll = managed.length > 0;

  return (
    <main className="grid w-full gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>Skills</PageHeaderTitle>
            <div className="flex items-center gap-1 sm:hidden">
              <Button
                aria-label="Search"
                onClick={openCommandMenu}
                size="icon-lg"
                type="button"
                variant="outline"
              >
                <SearchIcon />
                <span className="sr-only">Search</span>
              </Button>
              <PageHeaderSidebarTrigger />
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Reusable playbooks Ratel serves through the gateway. Activate a skill to move it from{" "}
            <code className="font-mono text-xs">~/.claude/skills</code> into Ratel's managed folder;
            deactivate to move it back.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden items-center sm:flex">
          <NewSkillDialog onCreated={load} />
          {canActivateAll && (
            <Button
              className="h-10"
              disabled={busy}
              onClick={() =>
                void mutate(
                  `Activated ${available.length} skill${available.length === 1 ? "" : "s"}`,
                  "/api/skills/activate",
                )
              }
              size="sm"
              variant="outline"
            >
              Activate all
            </Button>
          )}
          {canDeactivateAll && (
            <Button
              className="h-10"
              disabled={busy}
              onClick={() =>
                void mutate(
                  `Deactivated ${managed.length} skill${managed.length === 1 ? "" : "s"}`,
                  "/api/skills/deactivate",
                )
              }
              size="sm"
              variant="outline"
            >
              Deactivate all
            </Button>
          )}
          <ResponsiveToolbar>
            <ResponsiveToolbarButton
              icon={<SearchIcon />}
              kbd="⌘K"
              label="Search"
              onClick={openCommandMenu}
            />
          </ResponsiveToolbar>
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
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

      {ready && managed.length === 0 && available.length === 0 && (
        <EmptyState
          title="No skills found"
          description="Add Claude Code skills under ~/.claude/skills (or the Ratel-managed ~/.ratel/skills) and they'll show up here."
        />
      )}

      {ready && managed.length > 0 && (
        <SkillSection
          title="Active"
          caption={`Served by the gateway from ${ready.managedDir ?? ""}`}
          onView={openSkill}
          skills={managed}
          renderAction={(skill) => (
            <Button
              disabled={busy}
              onClick={() =>
                void mutate(`Deactivated ${skill.name}`, "/api/skills/deactivate", [skill.id])
              }
              size="sm"
              variant="outline"
            >
              Deactivate
            </Button>
          )}
        />
      )}

      {ready && available.length > 0 && (
        <SkillSection
          title="Available"
          caption={`Claude Code skills in ${ready.nativeDir ?? ""}, not yet served`}
          onView={openSkill}
          skills={available}
          renderAction={(skill) => (
            <Button
              disabled={busy}
              onClick={() =>
                void mutate(`Activated ${skill.name}`, "/api/skills/activate", [skill.id])
              }
              size="sm"
            >
              Activate
            </Button>
          )}
        />
      )}
    </main>
  );
}

const PAGE_SIZE = 8;

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

  return (
    <section className="grid gap-2">
      <div className="px-1">
        <h2 className="font-medium text-sm">
          {props.title} <span className="text-muted-foreground">({props.skills.length})</span>
        </h2>
        <p className="text-muted-foreground text-xs">{props.caption}</p>
      </div>
      <ul className="grid gap-2">
        {visible.map((skill) => (
          <li
            key={skill.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3"
          >
            <button
              className="min-w-0 text-left"
              onClick={() => props.onView(skill.id)}
              type="button"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 shrink-0 text-brand-green" />
                <strong className="truncate font-medium hover:underline">{skill.name}</strong>
              </div>
              {skill.description && (
                <p className="mt-1 text-muted-foreground text-sm">{skill.description}</p>
              )}
              {skill.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {skill.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </button>
            <div className="shrink-0">{props.renderAction(skill)}</div>
          </li>
        ))}
      </ul>
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

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
      <div className="grid max-w-md gap-3">
        <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
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
