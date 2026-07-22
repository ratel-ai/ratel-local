import { Check, ChevronsUpDown, FolderKanban, Globe2, LayoutGrid } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type ProjectView, projectLabel } from "@/lib/projects";
import type { RuntimeUiContext } from "@/lib/runtime-context";

interface ContextSwitcherProps {
  context: RuntimeUiContext;
  onSelect: (context: RuntimeUiContext) => void;
  projects: readonly ProjectView[];
}

export function ContextSwitcher({ context, onSelect, projects }: ContextSwitcherProps) {
  const selectedProject =
    context.kind === "project"
      ? projects.find((project) => project.id === context.projectId)
      : null;
  const label =
    context.kind === "all"
      ? "All projects"
      : context.kind === "global"
        ? "Global"
        : selectedProject
          ? projectLabel(selectedProject)
          : context.projectId;
  const SelectedIcon =
    context.kind === "all" ? LayoutGrid : context.kind === "global" ? Globe2 : FolderKanban;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Change context"
            className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-cream transition-colors hover:bg-forest/40"
            type="button"
          />
        }
      >
        <SelectedIcon className="size-4 shrink-0 text-coral" />
        <span className="max-w-48 truncate font-semibold max-sm:max-w-28">{label}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-warm-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="min-w-64 rounded-xl border-forest-300 bg-base-deep/95 p-1.5 backdrop-blur"
        side="bottom"
        sideOffset={8}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] tracking-wide uppercase text-warm-muted">
            Contexts
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onSelect({ kind: "all" })}>
            <LayoutGrid />
            <span className="flex-1">All projects</span>
            {context.kind === "all" && <Check />}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSelect({ kind: "global" })}>
            <Globe2 />
            <span className="flex-1">Global</span>
            {context.kind === "global" && <Check />}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-[10px] tracking-wide uppercase text-warm-muted">
            Projects
          </DropdownMenuLabel>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>No registered projects</DropdownMenuItem>
          ) : (
            projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => onSelect({ kind: "project", projectId: project.id })}
              >
                <FolderKanban />
                <span className="min-w-0 flex-1 truncate">{projectLabel(project)}</span>
                {context.kind === "project" && context.projectId === project.id && <Check />}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
