import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Save, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRatelApp } from "@/App";
import { Markdown } from "@/components/markdown";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderSidebarTrigger,
  PageHeaderTitle,
} from "@/components/page-header";
import { type SkillSource, SourceIcon, sourceLabel } from "@/components/source-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  state: "active" | "available";
  source: SkillSource;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillDetail };

export function SkillDetailPage(props: { id: string }) {
  const navigate = useNavigate();
  const { request, runAction, busy, token } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [isEditing, setIsEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");

  const backPath = token ? `/skills?t=${encodeURIComponent(token)}` : "/skills";
  const goBack = () => {
    void navigate({ to: backPath } as never);
  };

  const load = useCallback(
    async (signal?: { cancelled: boolean }) => {
      setState({ status: "loading" });
      try {
        const data = await request<SkillDetail>(`/api/skills/${encodeURIComponent(props.id)}`);
        if (!signal?.cancelled) setState({ status: "ready", data });
      } catch (err) {
        if (!signal?.cancelled) {
          setState({
            status: "error",
            message: err instanceof Error ? err.message : "Failed to load skill",
          });
        }
      }
    },
    [request, props.id],
  );

  // Guard against a superseded load: if `id` changes (or the page unmounts)
  // before the request resolves, cancel so a stale response can't clobber the
  // newer skill's state.
  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const startEdit = () => {
    if (state.status !== "ready") return;
    setDescription(state.data.description);
    setTags(state.data.tags.join(", "));
    setBody(state.data.body);
    setIsEditing(true);
  };

  const save = async () => {
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const saved = await runAction(`Updated ${props.id}`, () =>
      request(`/api/skills/${encodeURIComponent(props.id)}`, {
        method: "PATCH",
        body: { description: description.trim(), tags: tagList, body },
      }),
    );
    if (saved) {
      setIsEditing(false);
      await load();
    }
  };

  const detail = state.status === "ready" ? state.data : null;
  // Unmanaged skills live in an agent's own folder (Claude / Codex); they're
  // read-only here until brought into Ratel (the backend rejects the PATCH too).
  const canEdit = detail?.state === "active";
  const canSave = description.trim() !== "" && !busy;

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Skills
            </Button>
            <div className="flex items-center gap-1 sm:hidden">
              <PageHeaderSidebarTrigger />
            </div>
          </PageHeaderBackRow>
          <div className="mt-4 flex min-w-0 flex-wrap items-center gap-2">
            {detail && <SourceIcon source={detail.state === "active" ? "ratel" : detail.source} />}
            <PageHeaderTitle className="truncate text-2xl">
              {detail?.name ?? props.id}
            </PageHeaderTitle>
            {detail && (
              <Badge variant="outline">
                {detail.state === "active"
                  ? "Managed by Ratel"
                  : `From ${sourceLabel(detail.source)}`}
              </Badge>
            )}
          </div>
          {detail && !isEditing && (
            <PageHeaderDescription className="mt-2">
              {detail.description || "No description stored for this skill."}
            </PageHeaderDescription>
          )}
        </PageHeaderContent>

        <PageHeaderActions className="hidden sm:flex">
          {detail &&
            canEdit &&
            (isEditing ? (
              <>
                <Button
                  onClick={() => setIsEditing(false)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <X />
                  Cancel
                </Button>
                <Button disabled={!canSave} onClick={() => void save()} size="sm" type="button">
                  <Save />
                  Save
                </Button>
              </>
            ) : (
              <Button onClick={startEdit} size="sm" type="button" variant="outline">
                <Pencil />
                Edit
              </Button>
            ))}
          <PageHeaderSidebarTrigger className="hidden sm:inline-flex" />
        </PageHeaderActions>
      </PageHeader>

      {state.status === "loading" && (
        <p className="px-1 text-muted-foreground text-sm">Loading skill…</p>
      )}

      {state.status === "error" && (
        <div className="grid gap-3">
          <p className="text-destructive text-sm">{state.message}</p>
          <div>
            <Button onClick={() => void load()} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        </div>
      )}

      {detail && !isEditing && (
        <div className="grid gap-3">
          {detail.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {detail.tags.map((t) => (
                <span
                  className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
                  key={t}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {detail.body.trim() ? (
            <div className="rounded-md border border-border bg-card p-4">
              <Markdown>{detail.body}</Markdown>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">(no instructions)</p>
          )}
          {canEdit ? (
            <div className="sm:hidden">
              <Button onClick={startEdit} size="sm" type="button" variant="outline">
                <Pencil />
                Edit
              </Button>
            </div>
          ) : (
            detail && (
              <p className="text-muted-foreground text-xs">
                This skill is managed by {sourceLabel(detail.source)} and is read-only here. Bring
                it into Ratel from the Skills page to edit it.
              </p>
            )
          )}
        </div>
      )}

      {detail && isEditing && (
        <div className="grid max-w-3xl gap-4">
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
              className="min-h-80 font-mono text-xs"
              id="skill-body"
              onChange={(e) => setBody(e.target.value)}
              placeholder="# How to…"
              value={body}
            />
          </div>
          <div className="flex items-center gap-2 sm:hidden">
            <Button onClick={() => setIsEditing(false)} size="sm" type="button" variant="outline">
              <X />
              Cancel
            </Button>
            <Button disabled={!canSave} onClick={() => void save()} size="sm" type="button">
              <Save />
              Save
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
