import { FolderKanban, RefreshCw, SearchIcon } from "lucide-react";
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
import {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
} from "@/components/responsive-toolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { projectLabel } from "@/lib/projects";
import { contextPagePath } from "@/lib/runtime-context";

export function AllProjectsPage() {
  const { openCommandMenu, projects, projectsError, projectsLoading, refreshProjects, token } =
    useRatelApp();
  const availableCount = projects.filter(
    (project) => project.available === true || project.status === "available",
  ).length;
  const missingCount = projects.filter(
    (project) => project.missing === true || project.status === "missing",
  ).length;
  const clientCount = projects.reduce((sum, project) => sum + (project.clientCount ?? 0), 0);
  const staleClientCount = projects.reduce(
    (sum, project) => sum + (project.staleClientCount ?? 0),
    0,
  );

  const projectHref = (projectId: string) => {
    const path = contextPagePath({ kind: "project", projectId }, "/");
    return token ? `${path}?t=${encodeURIComponent(token)}` : path;
  };

  return (
    <main className="grid w-full gap-5 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>All projects</PageHeaderTitle>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Read-only daemon state across registered project contexts. Open a project to change its
            scoped configuration.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions>
          <PageHeaderSidebarTrigger />
          <ResponsiveToolbar>
            <ResponsiveToolbarGroup>
              <ResponsiveToolbarButton
                icon={<SearchIcon />}
                label="Search"
                onClick={openCommandMenu}
              />
              <ResponsiveToolbarButton
                disabled={projectsLoading}
                icon={projectsLoading ? <Spinner /> : <RefreshCw />}
                label="Refresh projects"
                onClick={() => void refreshProjects()}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      {projectsError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load projects</AlertTitle>
          <AlertDescription>{projectsError}</AlertDescription>
        </Alert>
      )}

      <section aria-label="Project summary" className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Registered</CardDescription>
            <CardTitle className="font-mono text-3xl">{projects.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Available / missing</CardDescription>
            <CardTitle className="font-mono text-3xl">
              {availableCount} / {missingCount}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Active clients</CardDescription>
            <CardTitle className="font-mono text-3xl">{clientCount}</CardTitle>
            {staleClientCount > 0 && (
              <CardDescription className="text-amber-700 dark:text-amber-300">
                {staleClientCount} need{staleClientCount === 1 ? "s" : ""} reconnect
              </CardDescription>
            )}
          </CardHeader>
        </Card>
      </section>

      {projects.length === 0 && !projectsLoading ? (
        <section className="grid min-h-72 place-items-center rounded-lg border border-dashed bg-muted/20 px-6 text-center">
          <div className="grid max-w-sm gap-2">
            <FolderKanban className="mx-auto size-7 text-muted-foreground" />
            <h2 className="font-medium">No registered projects</h2>
            <p className="text-muted-foreground text-sm">
              Register a root with ratel-local project add, then refresh this overview.
            </p>
          </div>
        </section>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Project contexts</CardTitle>
            <CardDescription>
              Availability and client counts are daemon read models; project files are never changed
              from this page.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Clients</TableHead>
                  <TableHead>Revision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => {
                  const missing = project.missing === true || project.status === "missing";
                  return (
                    <TableRow key={project.id}>
                      <TableCell className="min-w-64">
                        <a
                          className="grid max-w-full gap-0.5 text-left hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          href={projectHref(project.id)}
                        >
                          <span className="truncate font-medium">{projectLabel(project)}</span>
                          <span className="truncate font-mono text-muted-foreground text-xs">
                            {project.canonicalRoot}
                          </span>
                        </a>
                      </TableCell>
                      <TableCell>
                        <Badge variant={missing ? "destructive" : "outline"}>
                          {missing ? "Missing" : project.connected ? "Connected" : "Available"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {project.clientCount ?? 0}
                      </TableCell>
                      <TableCell className="max-w-52">
                        <code className="block truncate font-mono text-muted-foreground text-xs">
                          {project.runtimeRevision ?? "Not resolved"}
                        </code>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
