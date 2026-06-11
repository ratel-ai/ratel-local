import { SearchIcon, Sparkles } from "lucide-react";
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

export function SkillsPage() {
  const { openCommandMenu } = useRatelApp();

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
            Future tool-providing capabilities will appear here when Ratel has a skills model.
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

      <section className="-mx-4 grid min-h-72 place-items-center border-border border-y bg-muted/15 px-4 py-8 text-center sm:-mx-6 sm:px-6">
        <div className="grid max-w-md gap-3">
          <div className="mx-auto rounded-md bg-muted p-2 text-brand-green">
            <Sparkles className="size-5" />
          </div>
          <div>
            <h3 className="font-medium">Skill support is coming soon</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This page is reserved for future capabilities that can provide tools. There is no
              editable skills state in this build.
            </p>
          </div>
          <div>
            <Button disabled size="sm" variant="outline">
              Browse skills
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
