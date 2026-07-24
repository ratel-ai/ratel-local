import { useNavigate } from "@tanstack/react-router";
import { LinkIcon, Sparkles, TriangleAlert } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { skillPath, useRatelApp } from "@/App";
import { EmptyStateIcon } from "@/components/empty-state-icon";
import { ImportSkillsDialog } from "@/components/import-skills-dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/page-header";
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
import { type Segment, SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { projectLabel } from "@/lib/projects";
import { scopeTarget } from "@/lib/runtime-context";
import {
  availableSkillImportScopes,
  configuredSkillRegistrationGroups,
  defaultSkillImportTarget,
  discoveredSkillSummaries,
  effectiveSkillSummaries,
  type SkillImportScope,
  type SkillRegistrationView,
  type SkillSummary,
  type SkillsResponse,
} from "@/lib/skills";
import { cn } from "@/lib/utils";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillsResponse };

export function SkillsPage() {
  const { busy, context, request, runAction, token } = useRatelApp();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [importOpen, setImportOpen] = useState(false);
  const [configuredScope, setConfiguredScope] = useState<"user" | "project" | "local">("user");
  const [sourceFilter, setSourceFilter] = useState<"all" | SkillSource>("all");

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
  const scopeOptions: Segment<"user" | "project" | "local">[] = registrationGroups.map((group) => ({
    label: `${scopeLabel(group.scope)} ${group.registrations.length}`,
    value: group.scope,
  }));
  const selectedRegistrationGroup = registrationGroups.find(
    (group) => group.scope === configuredScope,
  );
  const filteredManaged = managed.filter(
    (skill) => sourceFilter === "all" || skill.source === sourceFilter,
  );
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
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Reusable playbooks Ratel manages and serves through the gateway. Link skills from Claude
            Code or Codex as invoke-only without moving their native folders.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="items-center">
          <NewSkillDialog onCreated={load} />
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
        <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
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

      {ready && usesScopedResolver && registrationGroups.length > 0 && (
        <section className="flex flex-col gap-3 rounded-2xl border border-forest-300 bg-forest-600/40 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <SegmentedControl<"user" | "project" | "local">
              ariaLabel="Skill registration scope"
              onChange={setConfiguredScope}
              options={scopeOptions}
              value={configuredScope}
            />
            <p className="mt-2 text-sm text-muted-foreground">
              {selectedRegistrationGroup?.registrations.length ?? 0} skill registration
              {(selectedRegistrationGroup?.registrations.length ?? 0) === 1 ? "" : "s"} configured
              in this scope.
            </p>
          </div>
          <SkillSourceFilter
            onValueChange={(value) => setSourceFilter(value as "all" | SkillSource)}
            value={sourceFilter}
          />
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

      {ready && managed.length > 0 && filteredManaged.length === 0 && (
        <EmptyState
          title="No matching managed skills"
          description="Adjust the source filter to broaden the current skill list."
        >
          <Button onClick={() => setSourceFilter("all")} size="sm">
            Clear filters
          </Button>
        </EmptyState>
      )}

      {ready && filteredManaged.length > 0 && (
        <SkillSection
          title="Managed by Ratel"
          caption="Served through the gateway. Linked native skills remain in their agent folders."
          iconSource="ratel"
          onView={openSkill}
          skills={filteredManaged}
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
                  Stop managing
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

      {ready && usesScopedResolver && selectedRegistrationGroup && (
        <section className="grid gap-3 border-border border-t pt-4">
          <div className="px-1">
            <h2 className="font-medium text-sm">
              {scopeLabel(selectedRegistrationGroup.scope)} registrations
            </h2>
            <p className="text-muted-foreground text-xs">
              Inspect and manage the skills configured directly in this scope.
            </p>
          </div>
          <ConfiguredRegistrationList
            busy={busy}
            onRemove={removeRegistration}
            registrations={selectedRegistrationGroup.registrations}
            scope={selectedRegistrationGroup.scope}
          />
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

function SkillSourceFilter(props: {
  onValueChange: (value: string) => void;
  value: "all" | SkillSource;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(9rem,1fr)] items-center gap-3 sm:w-fit">
      <span className="font-mono text-xs text-muted-foreground uppercase">Source</span>
      <Select onValueChange={props.onValueChange} value={props.value}>
        <SelectTrigger aria-label="Filter by source" className="min-w-40">
          <SelectValue>
            {props.value === "all" ? "All sources" : sourceLabel(props.value)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All sources</SelectItem>
          <SelectItem value="ratel">Ratel</SelectItem>
          <SelectItem value="claude">Claude Code</SelectItem>
          <SelectItem value="codex">Codex</SelectItem>
        </SelectContent>
      </Select>
    </div>
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
              Stop managing
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
const SKILL_ROW_GRID = "lg:grid-cols-[minmax(16rem,1.45fr)_10rem_minmax(12rem,0.9fr)_9rem]";

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
      <div className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40">
        <div
          className={cn(
            "hidden gap-3 border-border border-b px-4 py-2.5 font-mono text-[11px] font-normal tracking-[0.08em] text-muted-foreground uppercase sm:px-6 lg:grid",
            SKILL_ROW_GRID,
          )}
        >
          <span>Skill</span>
          <span>Source</span>
          <span className="text-right">Tags</span>
          <span>Action</span>
        </div>
        <div className="divide-y divide-border/60">
          {visible.map((skill) => (
            <SkillRow
              iconSource={props.iconSource}
              key={`${skill.source}:${skill.id}`}
              onView={props.onView}
              renderAction={props.renderAction}
              skill={skill}
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

function SkillRow({
  iconSource,
  onView,
  renderAction,
  skill,
}: {
  iconSource?: SkillSource;
  onView: (id: string) => void;
  renderAction: (skill: SkillSummary) => ReactNode;
  skill: SkillSummary;
}) {
  const modeLabel = managedSkillModeLabel(skill);

  return (
    <div
      className={cn(
        "relative grid gap-3 px-4 py-3 text-sm transition-colors hover:bg-forest/30 focus-within:bg-forest/30 sm:px-6 lg:grid lg:items-center",
        SKILL_ROW_GRID,
      )}
    >
      <button
        aria-label={`Open ${skill.name}`}
        className="absolute inset-0 z-10 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
        onClick={() => onView(skill.id)}
        type="button"
      />

      <div className="relative z-20 grid min-w-0 gap-3 lg:hidden">
        <div className="pointer-events-none flex min-w-0 items-start justify-between gap-3">
          <strong className="block truncate font-medium">{skill.name}</strong>
          <div className="pointer-events-auto relative z-30 shrink-0">{renderAction(skill)}</div>
        </div>
        {skill.description ? (
          <p className="pointer-events-none line-clamp-2 text-muted-foreground">
            {skill.description}
          </p>
        ) : null}
        {modeLabel ? <SkillModeLabel>{modeLabel}</SkillModeLabel> : null}
        <div className="pointer-events-none grid min-w-0 grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <span className="font-mono text-xs text-muted-foreground uppercase">Source</span>
          <SkillSourceLabel source={iconSource ?? skill.source} />
          <span className="font-mono text-xs text-muted-foreground uppercase">Tags</span>
          <div className="min-w-0 text-right">
            <SkillTagLabel tags={skill.tags} />
          </div>
        </div>
      </div>

      <div className="pointer-events-none relative z-20 hidden min-w-0 lg:block">
        <strong className="block truncate font-medium">{skill.name}</strong>
        {skill.description ? (
          <p className="mt-1 line-clamp-2 text-muted-foreground">{skill.description}</p>
        ) : null}
        {modeLabel ? <SkillModeLabel className="mt-1.5">{modeLabel}</SkillModeLabel> : null}
      </div>
      <div className="pointer-events-none relative z-20 hidden lg:block">
        <SkillSourceLabel source={iconSource ?? skill.source} />
      </div>
      <div className="pointer-events-none relative z-20 hidden min-w-0 text-right lg:block">
        <SkillTagLabel tags={skill.tags} />
      </div>
      <div className="relative z-30 hidden lg:flex lg:justify-start">{renderAction(skill)}</div>
    </div>
  );
}

function SkillSourceLabel({ source }: { source: SkillSource }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <SourceIcon source={source} />
      <span className="truncate font-medium">{sourceLabel(source)}</span>
    </span>
  );
}

function SkillTagLabel({ tags }: { tags: string[] }) {
  if (tags.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">0 tags</span>;
  }

  return (
    <div className="grid justify-items-end gap-1">
      <span className="font-mono text-xs">{tags.length} tags</span>
      <div className="flex max-w-full flex-wrap justify-end gap-1">
        {tags.slice(0, 2).map((tag) => (
          <span
            className="max-w-24 truncate rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
            key={tag}
            title={tag}
          >
            {tag}
          </span>
        ))}
        {tags.length > 2 ? (
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
            +{tags.length - 2}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SkillModeLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "pointer-events-none inline-flex w-fit rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs",
        className,
      )}
    >
      {children}
    </span>
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
    <section className="grid min-h-72 flex-1 place-items-center rounded-2xl border border-forest-300 border-dashed bg-forest-600/20 px-6 py-8 text-center">
      <div className="grid max-w-md gap-3">
        <EmptyStateIcon>
          <Sparkles className="size-5" />
        </EmptyStateIcon>
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
  const { busy, context, projects, request, runAction } = useRatelApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<SkillImportScope>(
    defaultSkillImportTarget(context)?.scope ?? "user",
  );
  const availableScopes = availableSkillImportScopes(context);
  const project =
    context.kind === "project"
      ? projects.find((candidate) => candidate.id === context.projectId)
      : undefined;

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
        body: {
          target: scopeTarget(context, scope),
          name: name.trim(),
          description: description.trim(),
          tags: tagList,
          body,
        },
      }),
    );
    if (created) {
      setOpen(false);
      reset();
      await props.onCreated();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setScope(defaultSkillImportTarget(context)?.scope ?? "user");
      }}
    >
      <DialogTrigger render={<Button className="h-10" size="sm" />}>New skill</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Creates an owned skill copy in the selected Ratel scope; it is served through the
            gateway immediately.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="skill-scope">Destination</Label>
            <Select value={scope} onValueChange={(value) => setScope(value as SkillImportScope)}>
              <SelectTrigger aria-label="Skill destination" id="skill-scope">
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
            <p className="text-muted-foreground text-xs">
              {scope === "user" ? (
                <>Global · available to every project</>
              ) : (
                <>
                  Project:{" "}
                  {project
                    ? projectLabel(project)
                    : context.kind === "project"
                      ? context.projectId
                      : "Unknown"}
                  {scope === "local" ? " · machine-local" : " · shared project config"}
                </>
              )}
            </p>
          </div>
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
            disabled={
              busy ||
              availableScopes.length === 0 ||
              name.trim() === "" ||
              description.trim() === ""
            }
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
