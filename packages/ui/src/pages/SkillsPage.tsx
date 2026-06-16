import { SearchIcon, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRatelApp } from "@/App";
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

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

interface SkillsResponse {
  dir: string;
  skills: SkillSummary[];
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: SkillsResponse };

export function SkillsPage() {
  const { openCommandMenu, request } = useRatelApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
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
            Reusable playbooks Ratel serves through the gateway. Move them in and out of Ratel with{" "}
            <code className="font-mono text-xs">ratel-mcp skill activate</code>.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden sm:flex">
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
        <section className="-mx-4 grid min-h-72 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
          <div className="grid max-w-md gap-3">
            <h3 className="font-medium">Couldn't load skills</h3>
            <p className="text-muted-foreground text-sm">{state.message}</p>
            <div>
              <Button onClick={() => void load()} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          </div>
        </section>
      )}

      {state.status === "ready" && state.data.skills.length === 0 && (
        <section className="-mx-4 grid min-h-72 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
          <div className="grid max-w-md gap-3">
            <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h3 className="font-medium">No skills under Ratel management yet</h3>
              <p className="mt-1 text-muted-foreground text-sm">
                Run <code className="font-mono text-xs">ratel-mcp skill activate</code> to move your
                Claude Code skills into Ratel. Active skills are served on demand through{" "}
                <code className="font-mono text-xs">search_capabilities</code> and{" "}
                <code className="font-mono text-xs">get_skill_content</code>.
              </p>
            </div>
          </div>
        </section>
      )}

      {state.status === "ready" && state.data.skills.length > 0 && (
        <section className="grid gap-2">
          <p className="px-1 text-muted-foreground text-xs">
            {state.data.skills.length} skill{state.data.skills.length === 1 ? "" : "s"} served from{" "}
            <code className="font-mono">{state.data.dir}</code>
          </p>
          <ul className="grid gap-2">
            {state.data.skills.map((skill) => (
              <li key={skill.id} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 shrink-0 text-brand-green" />
                  <strong className="truncate font-medium">{skill.name}</strong>
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
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
