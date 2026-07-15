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
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
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
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip="Change context" />}>
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <SelectedIcon className="size-4" />
            </span>
            <span className="grid min-w-0 flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{label}</span>
              <span className="truncate text-xs text-sidebar-foreground/65">
                {context.kind === "project"
                  ? (selectedProject?.canonicalRoot ?? "Registered project")
                  : "Runtime context"}
              </span>
            </span>
            <ChevronsUpDown className="ml-auto size-4" />
          </DropdownMenuTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <DropdownMenuContent align="start" className="min-w-64" side="right" sideOffset={6}>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Contexts</DropdownMenuLabel>
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
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
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
