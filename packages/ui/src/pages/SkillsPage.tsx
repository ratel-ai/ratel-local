import { useNavigate } from "@tanstack/react-router";
import { LinkIcon, SearchIcon, Sparkles, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { skillPath, useRatelApp } from "@/App";
import { ImportSkillsDialog } from "@/components/import-skills-dialog";
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
import { type SkillSource, SourceIcon, sourceLabel } from "@/components/source-icon";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  configuredSkillRegistrationGroups,
  discoveredSkillSummaries,
  effectiveSkillSummaries,
  type SkillRegistrationView,
  type SkillSummary,
  type SkillsResponse,
} from "@/lib/skills";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillsResponse };

export function SkillsPage() {
  const { busy, context, openCommandMenu, request, runAction, token } = useRatelApp();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [importOpen, setImportOpen] = useState(false);
  const [configuredScope, setConfiguredScope] = useState<"user" | "project" | "local">("user");

  const openSkill = (id: string) => {
    void navigate({ to: skillPath(id, token, context) } as never);
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
  const managed = ready ? effectiveSkillSummaries(ready) : [];
  const available = ready ? discoveredSkillSummaries(ready) : [];
  const problems = ready?.problems ?? [];
  const canImport = available.length > 0;
  const usesScopedResolver = ready?.effectiveSkills !== undefined;
  const registrationGroups = ready ? configuredSkillRegistrationGroups(ready, context) : [];
  const loading = state.status === "loading";

  useEffect(() => {
    if (!registrationGroups.some(({ scope }) => scope === configuredScope)) {
      setConfiguredScope(registrationGroups[0]?.scope ?? "user");
    }
  }, [configuredScope, registrationGroups]);

  const removeRegistration = async (registration: SkillRegistrationView) => {
    const removed = await runAction(
      `Removed ${registration.id} from ${registration.scopeRef.scope}`,
      () =>
        request(`/api/skills/${encodeURIComponent(registration.id)}`, {
          method: "DELETE",
          body: { target: registration.scopeRef, deleteOwnedCopy: false },
        }),
    );
    if (removed) await load();
  };

  return (
    <main className="flex w-full flex-1 flex-col gap-4 px-4 py-5 sm:px-6">
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
            Reusable playbooks Ratel manages and serves through the gateway. Link skills from Claude
            Code or Codex as invoke-only without moving their native folders.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden items-center sm:flex">
          {!usesScopedResolver && <NewSkillDialog onCreated={load} />}
          <Button
            className="h-10"
            disabled={loading || !canImport}
            onClick={() => setImportOpen(true)}
            size="sm"
            variant="outline"
          >
            <LinkIcon />
            Manage skills
          </Button>
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

      {ready && managed.length === 0 && available.length > 0 && (
        <EmptyState
          title="No skills managed by Ratel yet"
          description="Manage skills from Claude Code or Codex as invoke-only so Ratel can serve them through the gateway."
        >
          <Button onClick={() => setImportOpen(true)} size="sm">
            <LinkIcon />
            Manage skills
          </Button>
        </EmptyState>
      )}

      {ready && managed.length === 0 && available.length === 0 && (
        <EmptyState
          title="No skills managed by Ratel yet"
          description="Add skills under ~/.claude/skills (Claude Code) or ~/.codex/skills (Codex), or create one in Ratel, then manage them here."
        />
      )}

      {ready && managed.length > 0 && (
        <SkillSection
          title="Managed by Ratel"
          caption="Served through the gateway. Linked native skills remain in their agent folders."
          iconSource="ratel"
          onView={openSkill}
          skills={managed}
          renderAction={(skill) => {
            const registration = skill.registration;
            if (registration?.ref.kind === "entry") {
              return (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void runAction(`Removed ${skill.name} from this scope`, () =>
                      request(`/api/skills/${encodeURIComponent(skill.id)}`, {
                        method: "DELETE",
                        body: { target: registration.scopeRef, deleteOwnedCopy: false },
                      }),
                    ).then((ok) => (ok ? load() : undefined))
                  }
                  size="sm"
                  variant="outline"
                >
                  Remove scope
                </Button>
              );
            }
            return skill.source === "ratel" ? (
              <span className="px-1 text-muted-foreground text-xs">Ratel skill</span>
            ) : usesScopedResolver ? (
              <span className="px-1 text-muted-foreground text-xs">Legacy registration</span>
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
            );
          }}
        />
      )}

      {ready && usesScopedResolver && registrationGroups.length > 0 && (
        <section className="grid gap-3 border-border border-t pt-4">
          <div className="px-1">
            <h2 className="font-medium text-sm">Configured registrations</h2>
            <p className="text-muted-foreground text-xs">
              Inspect effective, shadowed, duplicate, and invalid registrations without changing the
              runtime precedence view above.
            </p>
          </div>
          <Tabs
            onValueChange={(value) => setConfiguredScope(value as "user" | "project" | "local")}
            value={configuredScope}
          >
            <TabsList variant="line">
              {registrationGroups.map((group) => (
                <TabsTrigger key={group.scope} value={group.scope}>
                  {scopeLabel(group.scope)}
                  <span className="text-muted-foreground">{group.registrations.length}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            {registrationGroups.map((group) => (
              <TabsContent key={group.scope} value={group.scope}>
                <ConfiguredRegistrationList
                  busy={busy}
                  onRemove={removeRegistration}
                  registrations={group.registrations}
                  scope={group.scope}
                />
              </TabsContent>
            ))}
          </Tabs>
        </section>
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

function ConfiguredRegistrationList(props: {
  busy: boolean;
  onRemove: (registration: SkillRegistrationView) => void | Promise<void>;
  registrations: SkillRegistrationView[];
  scope: "user" | "project" | "local";
}) {
  if (props.registrations.length === 0) {
    return (
      <p className="rounded-md border border-border px-3 py-6 text-center text-muted-foreground text-sm">
        No {props.scope} registrations configured.
      </p>
    );
  }
  return (
    <ul className="grid gap-2">
      {props.registrations.map((registration) => (
        <li
          className="grid gap-3 rounded-md border border-border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          key={`${registration.id}:${registration.ref.kind}:${registration.configuredPath ?? ""}`}
        >
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <strong className="truncate font-medium">{registration.id}</strong>
              <Badge variant={registrationStateVariant(registration.state)}>
                {registration.state}
              </Badge>
              <Badge variant="outline">{registration.mode}</Badge>
              {registration.ref.kind === "legacy" && <Badge variant="muted">legacy</Badge>}
            </div>
            {registration.configuredPath && (
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {registration.configuredPath}
              </p>
            )}
            {(registration.diagnostics ?? []).map((diagnostic) => (
              <p className="mt-1 text-amber-700 text-xs dark:text-amber-400" key={diagnostic.code}>
                {diagnostic.message}
              </p>
            ))}
          </div>
          {registration.ref.kind === "entry" ? (
            <Button
              disabled={props.busy}
              onClick={() => void props.onRemove(registration)}
              size="sm"
              variant="outline"
            >
              Remove scope
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs">Configured by legacy directory</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function scopeLabel(scope: "user" | "project" | "local"): string {
  return scope[0].toUpperCase() + scope.slice(1);
}

function registrationStateVariant(
  state: SkillRegistrationView["state"],
): "secondary" | "warning" | "destructive" {
  if (state === "effective") return "secondary";
  if (state === "invalid") return "destructive";
  return "warning";
}

const PAGE_SIZE = 8;

function SkillSection(props: {
  title: string;
  caption: string;
  skills: SkillSummary[];
  /** Override the per-row source badge (e.g. force the Ratel mark for managed
   *  skills, which are hosted by Ratel regardless of where they came from). */
  iconSource?: SkillSource;
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
        {visible.map((skill) => {
          const modeLabel = managedSkillModeLabel(skill);
          return (
            <li
              key={`${skill.source}:${skill.id}`}
              className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
            >
              <SourceIcon source={props.iconSource ?? skill.source} />
              <button
                className="min-w-0 flex-1 text-left"
                onClick={() => props.onView(skill.id)}
                type="button"
              >
                <strong className="block truncate font-medium hover:underline">{skill.name}</strong>
                {modeLabel && (
                  <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                    {modeLabel}
                  </span>
                )}
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
          );
        })}
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

function managedSkillModeLabel(skill: SkillSummary): string | null {
  switch (skill.mode) {
    case "linked":
      return `Linked from ${sourceLabel(skill.source)}`;
    case "moved":
      return "Legacy managed copy";
    case "ratel":
      return "Created in Ratel";
    default:
      return null;
  }
}

function EmptyState(props: { title: string; description: string; children?: ReactNode }) {
  return (
    <section className="-mx-4 grid min-h-72 flex-1 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
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
