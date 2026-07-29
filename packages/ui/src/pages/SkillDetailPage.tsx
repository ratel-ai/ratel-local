import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Pencil, Save, X } from "lucide-react";
import { useState } from "react";
import { useRatelApp } from "@/App";
import { Markdown } from "@/components/markdown";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ratelApiQueryOptions, ratelQueryKeys } from "@/lib/ratel-query";
import { useRatelMutation } from "@/lib/use-ratel-mutation";

interface SkillDetail {
  id: string;
  name: string;
  description: string;
  tags: string[];
  body: string;
  state: "active" | "available";
  source: SkillSource;
  editable?: boolean;
  skillDocumentRevision?: string;
  registration?: {
    scopeRef: { scope: "user" } | { scope: "project" | "local"; projectId: string };
  };
}

export function SkillDetailPage(props: { id: string }) {
  const navigate = useNavigate();
  const { context, pagePath, request, token } = useRatelApp();
  const [isEditing, setIsEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [body, setBody] = useState("");

  const backPath = pagePath("/skills");
  const goBack = () => {
    void navigate({ to: backPath } as never);
  };

  const skillQuery = useQuery(
    ratelApiQueryOptions<SkillDetail>({
      context,
      path: `/api/skills/${encodeURIComponent(props.id)}`,
      queryKey: ratelQueryKeys.skill(context, props.id),
      token,
    }),
  );
  const saveMutation = useRatelMutation<
    unknown,
    {
      body: string;
      description: string;
      detail: SkillDetail;
      tags: string[];
    }
  >({
    invalidate: [ratelQueryKeys.skills(context)],
    mutationKey: [...ratelQueryKeys.skill(context, props.id), "update"],
    mutationFn: (values) =>
      request(`/api/skills/${encodeURIComponent(props.id)}`, {
        method: "PATCH",
        body: {
          ...(values.detail.registration ? { target: values.detail.registration.scopeRef } : {}),
          description: values.description,
          tags: values.tags,
          body: values.body,
          ...(values.detail.skillDocumentRevision
            ? { expectedRevision: values.detail.skillDocumentRevision }
            : {}),
        },
      }),
    onSuccess: () => setIsEditing(false),
    successMessage: `Updated ${props.id}`,
  });

  const startEdit = () => {
    if (!skillQuery.data) return;
    setDescription(skillQuery.data.description);
    setTags(skillQuery.data.tags.join(", "));
    setBody(skillQuery.data.body);
    setIsEditing(true);
  };

  const save = async () => {
    if (!skillQuery.data) return;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    saveMutation.mutate({
      body,
      description: description.trim(),
      detail: skillQuery.data,
      tags: tagList,
    });
  };

  const detail = skillQuery.data ?? null;
  // Unmanaged skills live in an agent's own folder (Claude / Codex); they're
  // read-only here until managed through Ratel (the backend rejects the PATCH too).
  const canEdit = detail?.editable === true;
  const canSave = description.trim() !== "" && !saveMutation.isPending;

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <Button onClick={goBack} size="sm" type="button" variant="ghost">
              <ArrowLeft />
              Skills
            </Button>
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
          {detail && detail.state === "active" && detail.source !== "ratel" && (
            <p className="mt-2 flex items-center gap-1.5 text-muted-foreground text-sm">
              Originally from
              <SourceIcon className="size-5" source={detail.source} />
              <span className="font-medium text-foreground">{sourceLabel(detail.source)}</span>
            </p>
          )}
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
                  {saveMutation.isPending && <Button.LoadingIndicator label="Saving skill" />}
                  Save
                </Button>
              </>
            ) : (
              <Button onClick={startEdit} size="sm" type="button" variant="outline">
                <Pencil />
                Edit
              </Button>
            ))}
        </PageHeaderActions>
      </PageHeader>

      {skillQuery.isPending && <p className="px-1 text-muted-foreground text-sm">Loading skill…</p>}

      {skillQuery.isError && (
        <div className="grid gap-3">
          <p className="text-destructive text-sm">{skillQuery.error.message}</p>
          <div>
            <Button onClick={() => void skillQuery.refetch()} size="sm" variant="outline">
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
                {detail.state === "active"
                  ? "This registration is a reference and its source is read-only here."
                  : `This skill is owned by ${sourceLabel(detail.source)} and is read-only here. Manage it through Ratel from the Skills page to edit it.`}
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
              {saveMutation.isPending && <Button.LoadingIndicator label="Saving skill" />}
              Save
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
