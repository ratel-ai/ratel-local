import { useHotkey } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  KeyRound,
  Layers3,
  LinkIcon,
  Loader2,
  Plus,
  RefreshCw,
  SearchIcon,
  Server,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { BrandLogo, brandLogoSources } from "@/components/brand-logo";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Calendar } from "@/components/ui/calendar";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DirectionProvider } from "@/components/ui/direction";
import { DotmSquare3 } from "@/components/ui/dotm-square-3";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  FamilyDrawerAnimatedContent,
  FamilyDrawerAnimatedWrapper,
  FamilyDrawerButton,
  FamilyDrawerClose,
  FamilyDrawerContent,
  FamilyDrawerHeader,
  FamilyDrawerRoot,
  FamilyDrawerSecondaryButton,
  FamilyDrawerTrigger,
  FamilyDrawerViewContent,
  useFamilyDrawer,
  type ViewsRegistry,
} from "@/components/ui/family-drawer";
import {
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarTrigger,
} from "@/components/ui/menubar";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface KitchenSinkProps {
  token: string;
}

const colorTokenGroups = [
  {
    name: "Brand",
    tokens: [
      { name: "Green", token: "--brand-green", tailwind: "brand-green", value: "#023A2E" },
      {
        name: "Green foreground",
        token: "--brand-green-foreground",
        tailwind: "brand-green-foreground",
      },
      { name: "Cream", token: "--brand-cream", tailwind: "brand-cream", value: "#EEE3CE" },
      {
        name: "Cream foreground",
        token: "--brand-cream-foreground",
        tailwind: "brand-cream-foreground",
      },
      { name: "Orange", token: "--brand-orange", tailwind: "brand-orange", value: "#F6572C" },
      {
        name: "Orange foreground",
        token: "--brand-orange-foreground",
        tailwind: "brand-orange-foreground",
      },
      { name: "Azure", token: "--brand-azure", tailwind: "brand-azure", value: "#7BA0A0" },
      {
        name: "Azure foreground",
        token: "--brand-azure-foreground",
        tailwind: "brand-azure-foreground",
      },
    ],
  },
  {
    name: "shadcn surfaces",
    tokens: [
      { name: "Background", token: "--background", tailwind: "background" },
      { name: "Foreground", token: "--foreground", tailwind: "foreground" },
      { name: "Card", token: "--card", tailwind: "card" },
      { name: "Card foreground", token: "--card-foreground", tailwind: "card-foreground" },
      { name: "Popover", token: "--popover", tailwind: "popover" },
      {
        name: "Popover foreground",
        token: "--popover-foreground",
        tailwind: "popover-foreground",
      },
    ],
  },
  {
    name: "shadcn controls",
    tokens: [
      { name: "Primary", token: "--primary", tailwind: "primary" },
      {
        name: "Primary foreground",
        token: "--primary-foreground",
        tailwind: "primary-foreground",
      },
      { name: "Secondary", token: "--secondary", tailwind: "secondary" },
      {
        name: "Secondary foreground",
        token: "--secondary-foreground",
        tailwind: "secondary-foreground",
      },
      { name: "Muted", token: "--muted", tailwind: "muted" },
      {
        name: "Muted foreground",
        token: "--muted-foreground",
        tailwind: "muted-foreground",
      },
      { name: "Accent", token: "--accent", tailwind: "accent" },
      {
        name: "Accent foreground",
        token: "--accent-foreground",
        tailwind: "accent-foreground",
      },
      { name: "Destructive", token: "--destructive", tailwind: "destructive" },
      {
        name: "Destructive foreground",
        token: "--destructive-foreground",
        tailwind: "destructive-foreground",
      },
      { name: "Border", token: "--border", tailwind: "border" },
      { name: "Input", token: "--input", tailwind: "input" },
      { name: "Ring", token: "--ring", tailwind: "ring" },
    ],
  },
  {
    name: "Charts",
    tokens: [
      { name: "Chart 1", token: "--chart-1", tailwind: "chart-1" },
      { name: "Chart 2", token: "--chart-2", tailwind: "chart-2" },
      { name: "Chart 3", token: "--chart-3", tailwind: "chart-3" },
      { name: "Chart 4", token: "--chart-4", tailwind: "chart-4" },
      { name: "Chart 5", token: "--chart-5", tailwind: "chart-5" },
    ],
  },
  {
    name: "Sidebar",
    tokens: [
      { name: "Sidebar", token: "--sidebar", tailwind: "sidebar" },
      {
        name: "Sidebar foreground",
        token: "--sidebar-foreground",
        tailwind: "sidebar-foreground",
      },
      { name: "Sidebar primary", token: "--sidebar-primary", tailwind: "sidebar-primary" },
      {
        name: "Sidebar primary foreground",
        token: "--sidebar-primary-foreground",
        tailwind: "sidebar-primary-foreground",
      },
      { name: "Sidebar accent", token: "--sidebar-accent", tailwind: "sidebar-accent" },
      {
        name: "Sidebar accent foreground",
        token: "--sidebar-accent-foreground",
        tailwind: "sidebar-accent-foreground",
      },
      { name: "Sidebar border", token: "--sidebar-border", tailwind: "sidebar-border" },
      { name: "Sidebar ring", token: "--sidebar-ring", tailwind: "sidebar-ring" },
    ],
  },
] as const;

const logoSamples = [
  {
    name: "Green + cream",
    src: brandLogoSources.greenCream,
    surface: "var(--brand-cream)",
  },
  { name: "Green", src: brandLogoSources.green, surface: "var(--brand-cream)" },
  { name: "Cream", src: brandLogoSources.cream, surface: "var(--brand-green)" },
  {
    name: "Azure + cream",
    src: brandLogoSources.azureCream,
    surface: "var(--brand-green)",
  },
  {
    name: "Orange + cream",
    src: brandLogoSources.orangeCream,
    surface: "var(--brand-green)",
  },
] as const;

const badgeSamples = [
  { label: "ok", variant: "outline" },
  { label: "needs auth", variant: "warning" },
  { label: "linked", variant: "secondary" },
  { label: "new", variant: "default" },
] as const;

const serverRows = [
  {
    name: "filesystem",
    status: "ok",
    transport: "stdio",
    summary: "npx -y @modelcontextprotocol/server-filesystem ~/Projects",
  },
  {
    name: "github",
    status: "needs auth",
    transport: "http",
    summary: "https://api.githubcopilot.com/mcp/",
  },
  {
    name: "playwright",
    status: "linked",
    transport: "stdio",
    summary: "pnpm dlx @playwright/mcp@latest",
  },
] as const;

const commandLog = [
  "[ratel] imported 3 servers into project scope",
  "[ratel] linked Claude Code to Ratel",
  "[ratel] wrote /Users/marcello/work/.ratel/config.json",
] as const;

const commandLogRows = commandLog.flatMap((line) => [
  { id: `first-${line}`, line },
  { id: `second-${line}`, line },
]);

const otpSlotIndexes = [0, 1, 2, 3, 4, 5] as const;

const chartData = [
  { scope: "user", servers: 5 },
  { scope: "project", servers: 8 },
  { scope: "local", servers: 2 },
];

export function KitchenSink({ token }: KitchenSinkProps) {
  const navigate = useNavigate();
  const [scope, setScope] = useState("project");
  const [transport, setTransport] = useState("stdio");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useHotkey("Mod+K", () => setCommandOpen((open) => !open), {
    meta: {
      name: "Open command menu",
      description: "Toggle the Ratel command palette.",
    },
  });

  return (
    <>
      <div className="min-h-screen bg-background text-foreground">
        <header className="border-border border-b bg-background px-4 py-3 sm:px-6">
          <div className="mx-auto flex max-w-7xl flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  <Wand2 />
                  Temporary
                </Badge>
                <Badge variant="outline">Design system</Badge>
              </div>
              <h1 className="flex min-w-0 flex-wrap items-end gap-2 text-3xl leading-none font-semibold tracking-tight text-brand-green md:text-4xl">
                <BrandLogo className="h-10 w-auto max-w-[180px] md:h-12 md:max-w-[220px]" />
                <span>UI Kitchen Sink</span>
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                A working surface for the current tokens, primitives, and product patterns.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void navigate({ to: "/", search: token ? { t: token } : {} })}
                size="sm"
                variant="outline"
              >
                <ArrowLeft />
                App
              </Button>
              <Button
                onClick={() =>
                  void navigate({ to: "/lab/blocks", search: token ? { t: token } : {} })
                }
                size="sm"
                variant="outline"
              >
                <Layers3 />
                Blocks
              </Button>
              <Button
                onClick={() => toast.success("Toast surface", { description: "Action completed" })}
                size="sm"
              >
                <CheckCircle2 />
                Toast
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[190px_minmax(0,1fr)]">
          <nav className="h-fit rounded-lg border border-border bg-card p-1.5 text-sm text-card-foreground lg:sticky lg:top-4">
            {[
              ["Foundation", "#foundation"],
              ["Controls", "#controls"],
              ["Components", "#components"],
              ["Patterns", "#patterns"],
              ["Overlays", "#overlays"],
            ].map(([label, href]) => (
              <a
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                href={href}
                key={href}
              >
                {label}
                <ExternalLink className="size-3" />
              </a>
            ))}
          </nav>

          <div className="grid min-w-0 gap-6">
            <section className="grid gap-4" id="foundation">
              <SectionHeading
                eyebrow="Foundation"
                title="Tokens, type, and surfaces"
                body="The current visual language in one place."
              />
              <Card size="sm">
                <CardHeader>
                  <CardTitle>Logo Assets</CardTitle>
                  <CardDescription>
                    Web-ready variants from the supplied brand package.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                  {logoSamples.map((logo) => (
                    <div className="min-w-0 rounded-md bg-muted/35 p-2" key={logo.name}>
                      <div
                        className="flex h-20 items-center rounded-sm px-3"
                        style={{ background: logo.surface }}
                      >
                        <img
                          alt={logo.name}
                          className="max-h-12 max-w-full object-contain"
                          src={logo.src}
                        />
                      </div>
                      <p className="mt-2 truncate text-sm font-medium">{logo.name}</p>
                    </div>
                  ))}
                </CardContent>
              </Card>
              <div className="grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.55fr)]">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Tailwind Color Tokens</CardTitle>
                    <CardDescription>
                      Brand and shadcn colors exposed through Tailwind utilities.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    {colorTokenGroups.map((group) => (
                      <div className="grid gap-2" key={group.name}>
                        <div className="flex items-center justify-between gap-3 border-border border-b pb-1.5">
                          <h3 className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
                            {group.name}
                          </h3>
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {group.tokens.length}
                          </span>
                        </div>
                        <div className="grid gap-1.5 sm:grid-cols-2 2xl:grid-cols-3">
                          {group.tokens.map((tone) => (
                            <ColorTokenSwatch key={tone.token} {...tone} />
                          ))}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Type Scale</CardTitle>
                    <CardDescription>
                      Inter Tight headings and UI, JetBrains Mono code.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <div>
                      <p className="text-4xl leading-none font-semibold tracking-tight text-brand-green">
                        Gateway control
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">Heading / 36px</p>
                    </div>
                    <div>
                      <p className="text-base font-medium">Server inventory and scope status</p>
                      <p className="mt-1 text-sm text-muted-foreground">Body / 16px</p>
                    </div>
                    <code className="block overflow-hidden rounded-md bg-brand-green px-3 py-2 text-xs text-brand-green-foreground text-ellipsis whitespace-nowrap shadow-sm">
                      ratel-mcp ui --port 5174 --no-open
                    </code>
                  </CardContent>
                </Card>
              </div>
            </section>

            <section className="grid gap-4" id="controls">
              <SectionHeading
                eyebrow="Controls"
                title="Buttons, badges, selectors, and inputs"
                body="Interactive primitives using the current variants and states."
              />
              <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Actions</CardTitle>
                    <CardDescription>
                      Primary actions use brand orange; system actions stay quieter.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-4">
                    <div className="flex flex-wrap gap-2">
                      <Button>
                        <Plus />
                        Add server
                      </Button>
                      <Button variant="outline">
                        <RefreshCw />
                        Refresh
                      </Button>
                      <Button variant="secondary">
                        <LinkIcon />
                        Link
                      </Button>
                      <Button variant="ghost">
                        <Copy />
                        Copy
                      </Button>
                      <Button variant="destructive">
                        <Trash2 />
                        Remove
                      </Button>
                    </div>
                    <Separator />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button aria-label="Refresh" size="icon" title="Refresh">
                        <RefreshCw />
                      </Button>
                      <Button
                        aria-label="Authorize"
                        size="icon"
                        title="Authorize"
                        variant="outline"
                      >
                        <KeyRound />
                      </Button>
                      <Button aria-label="Settings" size="icon-sm" title="Settings" variant="ghost">
                        <Settings2 />
                      </Button>
                      <Button disabled size="sm" variant="outline">
                        <Loader2 className="animate-spin" />
                        Working
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {badgeSamples.map((badge) => (
                        <Badge key={badge.label} variant={badge.variant}>
                          {badge.label}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/35 p-3">
                      <DotmSquare3
                        className="text-brand-green"
                        size={28}
                        dotSize={4}
                        speed={0.65}
                      />
                      <DotmSquare3
                        className="text-brand-orange"
                        size={28}
                        dotSize={4}
                        speed={0.55}
                      />
                      <DotmSquare3
                        className="text-brand-green"
                        size={28}
                        dotSize={4}
                        speed={0.45}
                      />
                    </div>
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Server Form</CardTitle>
                    <CardDescription>Dense fields for add/edit server workflows.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form className="grid gap-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Name" name="ks-name">
                          <Input id="ks-name" placeholder="github" />
                        </Field>
                        <Field label="Transport" name="ks-transport">
                          <Select value={transport} onValueChange={setTransport}>
                            <SelectTrigger id="ks-transport" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="stdio">stdio</SelectItem>
                              <SelectItem value="http">http</SelectItem>
                              <SelectItem value="sse">sse</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                      <Field label={transport === "stdio" ? "Command" : "URL"} name="ks-command">
                        <Input
                          id="ks-command"
                          placeholder={
                            transport === "stdio"
                              ? "pnpm dlx @modelcontextprotocol/server"
                              : "https://example.com/mcp"
                          }
                        />
                      </Field>
                      <Field label="Description" name="ks-description">
                        <Textarea
                          id="ks-description"
                          placeholder="Short operational note for this server."
                        />
                      </Field>
                    </form>
                  </CardContent>
                  <CardFooter className="justify-end gap-2">
                    <Button variant="outline">Cancel</Button>
                    <Button>
                      <Plus />
                      Add
                    </Button>
                  </CardFooter>
                </Card>
              </div>
            </section>

            <section className="grid gap-4" id="components">
              <SectionHeading
                eyebrow="Installed shadcn"
                title="Component Coverage"
                body="Examples adapted from the official shadcn component gallery and tailored to Ratel workflows."
              />
              <ShadcnComponentGallery onOpenCommandMenu={() => setCommandOpen(true)} />
            </section>

            <section className="grid gap-4" id="patterns">
              <SectionHeading
                eyebrow="Patterns"
                title="Ratel product surfaces"
                body="Representative page states for scope navigation, server rows, backups, and command output."
              />
              <div className="grid gap-4">
                <ProductOverviewPreview />
                <ServerInventoryPreview scope={scope} onScopeChange={setScope} />
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                  <div className="grid gap-4">
                    <AuthQueuePreview />
                    <AgentSetupPreview />
                  </div>
                  <div className="grid gap-4 content-start">
                    <BackupHistoryPreview />
                    <CommandOutputPreview />
                    <SkillsComingSoonPreview />
                  </div>
                </div>
              </div>
            </section>

            <section className="grid gap-4" id="overlays">
              <SectionHeading
                eyebrow="Overlays"
                title="Alerts, dialogs, and confirmations"
                body="Transient states used by auth, import, remove, and save flows."
              />
              <div className="grid gap-4 xl:grid-cols-2">
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Alerts</CardTitle>
                    <CardDescription>Inline feedback with optional actions.</CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <Alert>
                      <ShieldCheck />
                      <AlertTitle>Session active</AlertTitle>
                      <AlertDescription>
                        Requests include the bearer token from the current URL.
                      </AlertDescription>
                      <AlertAction>
                        <Button size="icon-xs" variant="ghost" aria-label="Copy token">
                          <Copy />
                        </Button>
                      </AlertAction>
                    </Alert>
                    <Alert variant="destructive">
                      <AlertTitle>Could not save server</AlertTitle>
                      <AlertDescription>scope "project" requires a project root</AlertDescription>
                    </Alert>
                  </CardContent>
                </Card>

                <Card size="sm">
                  <CardHeader>
                    <CardTitle>Modal Actions</CardTitle>
                    <CardDescription>Dialog and destructive confirmation examples.</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button onClick={() => setDialogOpen(true)} variant="outline">
                      <TerminalSquare />
                      Details
                    </Button>
                    <Button onClick={() => setConfirmOpen(true)} variant="destructive">
                      <Trash2 />
                      Remove
                    </Button>
                  </CardContent>
                </Card>
              </div>
            </section>
          </div>
        </main>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Server: github</DialogTitle>
            <DialogDescription>Structured JSON view inside a modal surface.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[45vh] overflow-auto rounded-md bg-brand-green p-3 font-mono text-xs text-brand-green-foreground shadow-sm">
            {JSON.stringify(
              {
                type: "http",
                url: "https://api.githubcopilot.com/mcp/",
                headers: { Accept: "application/json" },
              },
              null,
              2,
            )}
          </pre>
          <DialogFooter showCloseButton>
            <Button>
              <Copy />
              Copy JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove server</AlertDialogTitle>
            <AlertDialogDescription>Remove "github" from the project scope?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => setConfirmOpen(false)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogContent
          className="top-1/3 max-w-xl translate-y-0 overflow-hidden p-0"
          showCloseButton={false}
        >
          <Command>
            <CommandInput placeholder="Search Ratel..." />
            <CommandList>
              <CommandEmpty>No matching command.</CommandEmpty>
              <CommandGroup heading="Navigate">
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <Activity />
                  Overview
                  <CommandShortcut>G O</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <Server />
                  Servers
                  <CommandShortcut>G S</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <KeyRound />
                  Auth queue
                  <CommandShortcut>G A</CommandShortcut>
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <Plus />
                  Add server
                  <CommandShortcut>⌘ N</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <Download />
                  Import agent servers
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <LinkIcon />
                  Link agent to Ratel
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Servers">
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <Server />
                  filesystem
                  <CommandShortcut>stdio</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <KeyRound />
                  github
                  <CommandShortcut>needs auth</CommandShortcut>
                </CommandItem>
                <CommandItem onSelect={() => setCommandOpen(false)}>
                  <TerminalSquare />
                  playwright
                  <CommandShortcut>linked</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
      <Toaster />
    </>
  );
}

function SectionHeading(props: { body: string; eyebrow: string; title: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
        {props.eyebrow}
      </div>
      <h2 className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-brand-green">
        {props.title}
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{props.body}</p>
    </div>
  );
}

function ColorTokenSwatch(props: {
  name: string;
  tailwind: string;
  token: string;
  value?: string;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted/35 p-2">
      <div
        className="mb-2 h-10 rounded-sm shadow-inner"
        style={{ background: `var(${props.token})` }}
      />
      <div className="truncate text-sm font-medium">{props.name}</div>
      <code className="block truncate text-xs text-muted-foreground">var({props.token})</code>
      <code className="block truncate text-xs text-muted-foreground">bg-{props.tailwind}</code>
      <code className="block truncate text-xs text-muted-foreground">
        {props.value ?? "semantic"}
      </code>
    </div>
  );
}

function Field(props: { children: ReactNode; label: string; name: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={props.name}>{props.label}</Label>
      {props.children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ok") {
    return (
      <Badge variant="outline" className="border-brand-green/30 bg-brand-green/5 text-brand-green">
        ok
      </Badge>
    );
  }
  if (status === "linked") return <Badge variant="secondary">linked</Badge>;
  return <Badge variant="warning">needs auth</Badge>;
}

function EmptyPanel(props: { body: string; title: string }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-md bg-muted/35 p-4 text-center">
      <div>
        <Activity className="mx-auto mb-2 size-5 text-muted-foreground" />
        <p className="font-medium">{props.title}</p>
        <p className="text-sm text-muted-foreground">{props.body}</p>
      </div>
    </div>
  );
}

function ProductOverviewPreview() {
  const stats = [
    { label: "Configured servers", value: "8", detail: "4 user, 3 project, 1 local" },
    { label: "Needs auth", value: "2", detail: "github and stripe require attention" },
    { label: "Linked agents", value: "1", detail: "Claude Code routes through Ratel" },
    { label: "Latest backup", value: "14:08", detail: "created by import operation" },
  ];

  return (
    <Card size="sm">
      <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
        <div>
          <CardTitle>Overview page composition</CardTitle>
          <CardDescription>
            First screen after the sidebar lands: status, next actions, and current context.
          </CardDescription>
        </div>
        <CardAction className="flex gap-2">
          <Button size="sm" variant="outline">
            <RefreshCw />
            Refresh
          </Button>
          <Button size="sm">
            <Plus />
            Add server
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-4">
          {stats.map((stat) => (
            <div className="rounded-md bg-muted/45 p-3" key={stat.label}>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold text-brand-green">{stat.value}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{stat.detail}</p>
            </div>
          ))}
        </div>
        <Alert>
          <KeyRound />
          <AlertTitle>Two servers need authorization</AlertTitle>
          <AlertDescription>
            Prioritize auth recovery before importing or linking more agent configuration.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline">
              Review auth
            </Button>
          </AlertAction>
        </Alert>
      </CardContent>
    </Card>
  );
}

function ServerInventoryPreview(props: { onScopeChange: (scope: string) => void; scope: string }) {
  const rows = props.scope === "local" ? [] : serverRows;

  return (
    <Card size="sm">
      <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <CardTitle>Servers page composition</CardTitle>
          <CardDescription className="truncate">
            {props.scope === "user"
              ? "/Users/marcello/.ratel/config.json"
              : props.scope === "project"
                ? "/Users/marcello/work/ratel-mcp/.ratel/config.json"
                : "/Users/marcello/work/ratel-mcp/.ratel/local.json"}
          </CardDescription>
        </div>
        <CardAction className="flex gap-2">
          <Button size="sm" variant="outline">
            <RefreshCw />
            Refresh
          </Button>
          <Button size="sm">
            <Plus />
            Add server
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Tabs value={props.scope} onValueChange={props.onScopeChange}>
            <TabsList variant="line" className="justify-start">
              {["user", "project", "local"].map((item) => (
                <TabsTrigger
                  className="font-mono text-[11px] tracking-[0.14em] uppercase data-active:text-brand-green"
                  key={item}
                  value={item}
                >
                  {item}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">all transports</Badge>
            <Badge variant="warning">needs auth</Badge>
            <Badge variant="secondary">linked</Badge>
          </div>
        </div>

        {rows.length === 0 ? (
          <EmptyPanel title="No local overrides" body="Local scope is available but empty." />
        ) : (
          <div className="overflow-hidden rounded-md bg-muted/25">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Transport</TableHead>
                  <TableHead className="hidden md:table-cell">Target</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={`${props.scope}-${row.name}`}>
                    <TableCell>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-xs text-muted-foreground md:hidden">{row.summary}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="ghost">{row.transport}</Badge>
                    </TableCell>
                    <TableCell className="hidden max-w-[360px] md:table-cell">
                      <code className="block truncate font-mono text-xs text-muted-foreground">
                        {row.summary}
                      </code>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button aria-label="Details" size="icon-sm" title="Details" variant="ghost">
                          <Server />
                        </Button>
                        <Button
                          aria-label="Authorize"
                          size="icon-sm"
                          title="Authorize"
                          variant="ghost"
                        >
                          <KeyRound />
                        </Button>
                        <Button aria-label="Remove" size="icon-sm" title="Remove" variant="ghost">
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuthQueuePreview() {
  return (
    <Card size="sm">
      <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
        <div>
          <CardTitle>Auth page composition</CardTitle>
          <CardDescription>
            Group remote servers by actionability, not by config file.
          </CardDescription>
        </div>
        <CardAction>
          <Button size="sm" variant="outline">
            <KeyRound />
            Authorize all
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="divide-y divide-border">
          {[
            ["github", "needs auth", "https://api.githubcopilot.com/mcp/"],
            ["stripe", "expired", "https://mcp.stripe.com"],
            ["linear", "ok", "https://mcp.linear.app/sse"],
          ].map(([name, status, target]) => (
            <div
              className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[1fr_auto] sm:items-center"
              key={name}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{name}</span>
                  <StatusBadge status={status} />
                </div>
                <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                  {target}
                </code>
              </div>
              <Button disabled={status === "ok"} size="sm" variant="outline">
                <KeyRound />
                Authorize
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentSetupPreview() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Agent setup composition</CardTitle>
        <CardDescription>
          Import and link are separate flows with clear file impact.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2">
        <ActionPanel
          description="Copy detected MCP entries from supported agent configs into Ratel."
          icon={<Download />}
          paths=".claude.json, codex config.toml"
          title="Import from agents"
        />
        <ActionPanel
          description="Rewrite detected agents so future MCP traffic goes through Ratel."
          icon={<LinkIcon />}
          paths=".claude.json"
          title="Link agent to Ratel"
        />
      </CardContent>
    </Card>
  );
}

function ActionPanel(props: {
  description: string;
  icon: ReactNode;
  paths: string;
  title: string;
}) {
  return (
    <div className="grid gap-3 rounded-md bg-muted/45 p-3">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-background p-2 text-brand-green shadow-xs">{props.icon}</div>
        <div className="min-w-0">
          <p className="font-medium">{props.title}</p>
          <p className="text-sm text-muted-foreground">{props.description}</p>
        </div>
      </div>
      <div className="rounded-md bg-background/70 px-2 py-1.5 text-xs text-muted-foreground">
        Affects: <span className="font-mono">{props.paths}</span>
      </div>
      <Button size="sm" variant="outline">
        Review
      </Button>
    </div>
  );
}

function BackupHistoryPreview() {
  const backups = [
    ["import", "2026-05-29 14:08", "/Users/marcello/.claude.json"],
    ["edit", "2026-05-29 13:42", "/Users/marcello/.ratel/config.json"],
    ["link", "2026-05-29 13:16", "/Users/marcello/.claude.json"],
  ];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Backups page composition</CardTitle>
        <CardDescription>
          Show restore affordance where it actually works: latest only.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {backups.map(([action, time, path], index) => (
          <div
            className="grid gap-2 border-border border-t pt-3 first:border-t-0 first:pt-0"
            key={`${action}-${time}`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant={index === 0 ? "default" : "secondary"}>{action}</Badge>
                  <span className="text-sm font-medium">{time}</span>
                </div>
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{path}</p>
              </div>
              {index === 0 && (
                <Button size="sm" variant="outline">
                  <Undo2 />
                  Undo
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CommandOutputPreview() {
  return (
    <Card size="sm">
      <CardHeader className="grid-cols-[1fr_auto]">
        <div>
          <CardTitle>Command output composition</CardTitle>
          <CardDescription>Short logs from CLI-backed actions.</CardDescription>
        </div>
        <CardAction>
          <Button aria-label="Copy output" size="icon-sm" variant="ghost">
            <Copy />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg bg-brand-green text-brand-green-foreground shadow-sm">
          <div className="flex items-center justify-between border-brand-cream/15 border-b px-3 py-2">
            <div className="flex items-center gap-2 text-xs">
              <TerminalSquare className="size-3.5" />
              Import complete
            </div>
            <Badge
              variant="outline"
              className="border-brand-cream/30 bg-brand-cream/10 text-brand-cream"
            >
              3 lines
            </Badge>
          </div>
          <pre className="max-h-40 overflow-auto p-3 font-mono text-xs">
            {commandLog.join("\n")}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillsComingSoonPreview() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Skills composition placeholder</CardTitle>
        <CardDescription>Reserve the route shape before backend support exists.</CardDescription>
      </CardHeader>
      <CardContent>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Wand2 />
            </EmptyMedia>
            <EmptyTitle>Skill support coming soon</EmptyTitle>
            <EmptyDescription>
              Catalog, installed skills, and enablement state will live here.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button disabled size="sm" variant="outline">
              Browse skills
            </Button>
          </EmptyContent>
        </Empty>
      </CardContent>
    </Card>
  );
}

const cultFamilyDrawerViews: ViewsRegistry = {
  default: CultFamilyDrawerDefaultView,
  import: CultFamilyDrawerImportView,
  done: CultFamilyDrawerDoneView,
};

function CultFamilyDrawerDefaultView() {
  const { setView } = useFamilyDrawer();

  return (
    <>
      <FamilyDrawerHeader
        description="This is the Cult UI registry component with only demo content supplied by Ratel."
        icon={<Wand2 className="size-7 text-brand-green" />}
        title="Agent setup"
      />
      <div className="mt-5 grid gap-3">
        <FamilyDrawerButton onClick={() => setView("import")}>
          <Download className="size-5 text-muted-foreground" />
          Import detected servers
        </FamilyDrawerButton>
        <FamilyDrawerButton onClick={() => setView("done")}>
          <LinkIcon className="size-5 text-muted-foreground" />
          Link agent to Ratel
        </FamilyDrawerButton>
      </div>
    </>
  );
}

function CultFamilyDrawerImportView() {
  const { setView } = useFamilyDrawer();

  return (
    <>
      <FamilyDrawerHeader
        description="A taller second view, useful for checking the stock height animation."
        icon={<Download className="size-7 text-brand-green" />}
        title="Import servers"
      />
      <div className="mt-5 grid gap-2">
        {["filesystem", "github", "playwright"].map((name) => (
          <div
            className="flex items-center justify-between rounded-[16px] bg-muted px-4 py-3"
            key={name}
          >
            <span className="text-sm font-medium">{name}</span>
            <Badge variant={name === "github" ? "warning" : "outline"}>
              {name === "github" ? "needs auth" : "ready"}
            </Badge>
          </div>
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <FamilyDrawerSecondaryButton
          className="bg-muted text-foreground"
          onClick={() => setView("default")}
        >
          Back
        </FamilyDrawerSecondaryButton>
        <FamilyDrawerSecondaryButton
          className="bg-primary text-primary-foreground"
          onClick={() => setView("done")}
        >
          Import
        </FamilyDrawerSecondaryButton>
      </div>
    </>
  );
}

function CultFamilyDrawerDoneView() {
  const { setView } = useFamilyDrawer();

  return (
    <>
      <FamilyDrawerHeader
        description="The action completed and the flow can return to the first view."
        icon={<CheckCircle2 className="size-7 text-brand-green" />}
        title="Complete"
      />
      <pre className="mt-5 max-h-32 overflow-auto rounded-[16px] bg-brand-green p-3 font-mono text-xs text-brand-green-foreground">
        {commandLog.join("\n")}
      </pre>
      <FamilyDrawerSecondaryButton
        className="mt-5 bg-muted text-foreground"
        onClick={() => setView("default")}
      >
        Start over
      </FamilyDrawerSecondaryButton>
    </>
  );
}

function ShadcnComponentGallery(props: { onOpenCommandMenu: () => void }) {
  return (
    <TooltipProvider>
      <DirectionProvider direction="ltr">
        <div className="grid gap-x-8 gap-y-5 xl:grid-cols-2">
          <ComponentTile title="Accordion">
            <Accordion defaultValue={["auth"]}>
              <AccordionItem value="auth">
                <AccordionTrigger>OAuth status</AccordionTrigger>
                <AccordionContent>
                  Tokens are refreshed from the selected scope when the server supports auth.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="config">
                <AccordionTrigger>Config merge order</AccordionTrigger>
                <AccordionContent>User, project, then local overrides.</AccordionContent>
              </AccordionItem>
            </Accordion>
          </ComponentTile>

          <ComponentTile title="Avatar, Breadcrumb, Aspect Ratio">
            <div className="grid gap-4">
              <Breadcrumb>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink href="#">Ratel</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbLink href="#">Project</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage>Servers</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <div className="grid grid-cols-[96px_1fr] gap-3">
                <AspectRatio ratio={1} className="rounded-md bg-muted">
                  <BrandLogo className="h-full p-3" />
                </AspectRatio>
                <AvatarGroup>
                  <Avatar>
                    <AvatarFallback>RA</AvatarFallback>
                    <AvatarBadge />
                  </Avatar>
                  <Avatar>
                    <AvatarFallback>MC</AvatarFallback>
                  </Avatar>
                </AvatarGroup>
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Button Group, Toggle, Tooltip">
            <div className="flex flex-wrap items-center gap-3">
              <ButtonGroup>
                <Button variant="outline" size="sm">
                  User
                </Button>
                <Button variant="outline" size="sm">
                  Project
                </Button>
                <Button variant="outline" size="sm">
                  Local
                </Button>
              </ButtonGroup>
              <Toggle defaultPressed variant="outline">
                Live
              </Toggle>
              <ToggleGroup defaultValue={["stdio"]}>
                <ToggleGroupItem value="stdio">stdio</ToggleGroupItem>
                <ToggleGroupItem value="http">http</ToggleGroupItem>
              </ToggleGroup>
              <Tooltip>
                <TooltipTrigger render={<Button size="icon" variant="outline" />}>
                  <Settings2 />
                </TooltipTrigger>
                <TooltipContent>Scope settings</TooltipContent>
              </Tooltip>
            </div>
          </ComponentTile>

          <ComponentTile title="Forms, Field, Inputs">
            <FieldSet>
              <FieldGroup>
                <FieldLabel>
                  <Checkbox defaultChecked />
                  <FieldContent>
                    <FieldTitle>Enable auth refresh</FieldTitle>
                    <FieldDescription>Allow Ratel to renew upstream tokens.</FieldDescription>
                  </FieldContent>
                </FieldLabel>
                <FieldLabel>
                  <RadioGroup defaultValue="project" className="flex gap-3">
                    <RadioGroupItem value="user" />
                    <RadioGroupItem value="project" />
                    <RadioGroupItem value="local" />
                  </RadioGroup>
                  Scope priority
                </FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText>cmd</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput defaultValue="pnpm dlx @modelcontextprotocol/server" />
                </InputGroup>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Select defaultValue="project">
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">User</SelectItem>
                      <SelectItem value="project">Project</SelectItem>
                      <SelectItem value="local">Local</SelectItem>
                    </SelectContent>
                  </Select>
                  <InputOTP maxLength={6} defaultValue="024018">
                    <InputOTPGroup>
                      {otpSlotIndexes.map((index) => (
                        <InputOTPSlot index={index} key={index} />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              </FieldGroup>
            </FieldSet>
          </ComponentTile>

          <ComponentTile title="Select, Menus, Popover">
            <div className="flex flex-wrap gap-2">
              <Select defaultValue="project">
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="project">project</SelectItem>
                  <SelectItem value="local">local</SelectItem>
                </SelectContent>
              </Select>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" />}>
                  Actions
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>Server</DropdownMenuLabel>
                  <DropdownMenuItem>Import</DropdownMenuItem>
                  <DropdownMenuItem>Link</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>Remove</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Popover>
                <PopoverTrigger render={<Button variant="outline" />}>Config path</PopoverTrigger>
                <PopoverContent>
                  <code className="text-xs">.ratel/config.json</code>
                </PopoverContent>
              </Popover>
              <HoverCard>
                <HoverCardTrigger render={<Button variant="ghost" />}>
                  Hover status
                </HoverCardTrigger>
                <HoverCardContent>Last checked just now.</HoverCardContent>
              </HoverCard>
            </div>
          </ComponentTile>

          <ComponentTile title="Command menu, Context Menu, Menubar">
            <div className="grid gap-3">
              <Menubar>
                <MenubarMenu>
                  <MenubarTrigger>File</MenubarTrigger>
                  <MenubarContent>
                    <MenubarItem>Import servers</MenubarItem>
                    <MenubarSeparator />
                    <MenubarItem>Undo backup</MenubarItem>
                  </MenubarContent>
                </MenubarMenu>
              </Menubar>
              <ContextMenu>
                <ContextMenuTrigger className="rounded-md bg-muted/35 p-3 text-sm">
                  Right click for server actions
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem>Authorize</ContextMenuItem>
                  <ContextMenuItem>Copy command</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <div className="grid gap-2 rounded-md bg-muted/30 p-2">
                <button
                  className="flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:bg-muted/40"
                  onClick={props.onOpenCommandMenu}
                  type="button"
                >
                  <SearchIcon className="size-4" />
                  <span className="min-w-0 flex-1 truncate">
                    Search commands, servers, and setup actions...
                  </span>
                  <KbdGroup>
                    <Kbd>⌘</Kbd>
                    <Kbd>K</Kbd>
                  </KbdGroup>
                </button>
                <Command className="bg-transparent">
                  <CommandInput placeholder="Filter server inventory..." />
                  <CommandList className="max-h-40">
                    <CommandEmpty>No server found.</CommandEmpty>
                    <CommandGroup heading="Servers">
                      <CommandItem>
                        <Server />
                        filesystem <CommandShortcut>stdio</CommandShortcut>
                      </CommandItem>
                      <CommandItem>
                        <KeyRound />
                        github <CommandShortcut>needs auth</CommandShortcut>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Collapsible">
            <Collapsible defaultOpen>
              <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
                Toggle diagnostics
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
                Project root found, API proxy active, session token present.
              </CollapsibleContent>
            </Collapsible>
          </ComponentTile>

          <ComponentTile title="Navigation, Pagination">
            <div className="grid gap-4">
              <NavigationMenu>
                <NavigationMenuList>
                  <NavigationMenuItem>
                    <NavigationMenuTrigger>Scopes</NavigationMenuTrigger>
                    <NavigationMenuContent>
                      <div className="grid w-56 gap-2 p-2">
                        <NavigationMenuLink className="rounded-md p-2 hover:bg-muted">
                          User config
                        </NavigationMenuLink>
                        <NavigationMenuLink className="rounded-md p-2 hover:bg-muted">
                          Project config
                        </NavigationMenuLink>
                      </div>
                    </NavigationMenuContent>
                  </NavigationMenuItem>
                </NavigationMenuList>
              </NavigationMenu>
              <Pagination>
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious href="#" />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLink href="#" isActive>
                      1
                    </PaginationLink>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationEllipsis />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext href="#" />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </ComponentTile>

          <ComponentTile title="Progress, Slider, Switch, Spinner">
            <div className="grid gap-4">
              <Progress value={68}>
                <ProgressLabel>Import progress</ProgressLabel>
                <ProgressValue />
              </Progress>
              <Slider defaultValue={[68]} max={100} />
              <div className="flex items-center gap-3">
                <Switch defaultChecked />
                <span className="text-sm text-muted-foreground">Auto-refresh enabled</span>
                <Spinner className="size-4 text-primary" />
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Dot Matrix Loaders">
            <div className="grid gap-3 sm:grid-cols-3">
              <DotLoaderExample label="Square default">
                <DotmSquare3 className="text-brand-green" speed={0.65} />
              </DotLoaderExample>
              <DotLoaderExample label="Square orange">
                <DotmSquare3 className="text-brand-orange" speed={0.55} />
              </DotLoaderExample>
              <DotLoaderExample label="Square slow">
                <DotmSquare3 className="text-brand-green" speed={0.45} />
              </DotLoaderExample>
            </div>
          </ComponentTile>

          <ComponentTile title="Calendar, Carousel, Resizable">
            <div className="grid gap-4 lg:grid-cols-2">
              <Calendar mode="single" defaultMonth={new Date(2026, 4, 29)} />
              <div className="grid gap-3">
                <Carousel className="mx-10">
                  <CarouselContent>
                    {[1, 2, 3].map((item) => (
                      <CarouselItem key={item}>
                        <div className="grid h-24 place-items-center rounded-lg bg-muted font-mono">
                          {item}
                        </div>
                      </CarouselItem>
                    ))}
                  </CarouselContent>
                  <CarouselPrevious />
                  <CarouselNext />
                </Carousel>
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="min-h-24 rounded-md bg-muted/25"
                >
                  <ResizablePanel defaultSize={45} className="grid place-items-center text-sm">
                    list
                  </ResizablePanel>
                  <ResizableHandle />
                  <ResizablePanel defaultSize={55} className="grid place-items-center text-sm">
                    detail
                  </ResizablePanel>
                </ResizablePanelGroup>
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Empty, Item, Kbd">
            <div className="grid gap-4">
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Server />
                  </EmptyMedia>
                  <EmptyTitle>No local servers</EmptyTitle>
                  <EmptyDescription>Add one or import from an agent.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm">
                    <Plus />
                    Add server
                  </Button>
                </EmptyContent>
              </Empty>
              <ItemGroup>
                <Item variant="outline">
                  <ItemMedia variant="icon">
                    <ShieldCheck />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>github</ItemTitle>
                    <ItemDescription>Needs auth before link.</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <KbdGroup>
                      <Kbd>⌘</Kbd>
                      <Kbd>K</Kbd>
                    </KbdGroup>
                  </ItemActions>
                </Item>
              </ItemGroup>
            </div>
          </ComponentTile>

          <ComponentTile title="Scroll Area, Skeleton, Table">
            <div className="grid gap-4">
              <ScrollArea className="h-28 rounded-md bg-muted/25">
                <div className="grid gap-2 p-3 pr-6 text-sm">
                  {commandLogRows.map(({ id, line }) => (
                    <code key={id}>{line}</code>
                  ))}
                </div>
              </ScrollArea>
              <div className="grid gap-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Server</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>filesystem</TableCell>
                    <TableCell>ok</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>github</TableCell>
                    <TableCell>needs auth</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </ComponentTile>

          <ComponentTile title="Chart">
            <div className="grid h-56 grid-cols-[auto_1fr] gap-x-3 gap-y-2 rounded-md bg-muted/30 p-4">
              {chartData.map((item) => (
                <div className="contents" key={item.scope}>
                  <span className="self-center font-mono text-xs text-muted-foreground">
                    {item.scope}
                  </span>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-8 rounded-sm bg-primary"
                      style={{ width: `${item.servers * 10}%` }}
                    />
                    <span className="font-mono text-xs">{item.servers}</span>
                  </div>
                </div>
              ))}
              <div className="col-span-2 mt-2 border-border border-t pt-3 text-xs text-muted-foreground">
                Static chart treatment using design tokens, without runtime chart dependencies.
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Drawer and Sheet">
            <div className="grid gap-3">
              <div className="flex flex-wrap gap-2">
                <Drawer>
                  <DrawerTrigger asChild>
                    <Button variant="outline">Default drawer</Button>
                  </DrawerTrigger>
                  <DrawerContent>
                    <DrawerHeader>
                      <DrawerTitle>Import agent servers</DrawerTitle>
                      <DrawerDescription>
                        Review detected entries before writing config.
                      </DrawerDescription>
                    </DrawerHeader>
                  </DrawerContent>
                </Drawer>
                <Drawer>
                  <DrawerTrigger asChild>
                    <Button variant="outline">Detached drawer</Button>
                  </DrawerTrigger>
                  <DrawerContent detached>
                    <DrawerHeader>
                      <DrawerTitle>Confirm agent import</DrawerTitle>
                      <DrawerDescription>
                        Detached drawers work well for focused, short confirmation flows.
                      </DrawerDescription>
                    </DrawerHeader>
                    <div className="grid gap-3 px-4 pb-4">
                      <div className="rounded-md bg-muted/45 p-3">
                        <p className="text-sm font-medium">3 servers detected</p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          filesystem, github, and playwright will be copied into the project scope.
                        </p>
                      </div>
                      <Button>
                        <Download />
                        Import servers
                      </Button>
                    </div>
                  </DrawerContent>
                </Drawer>
                <Drawer direction="right">
                  <DrawerTrigger asChild>
                    <Button variant="outline">Detached side</Button>
                  </DrawerTrigger>
                  <DrawerContent detached variant="side">
                    <DrawerHeader>
                      <DrawerTitle>github</DrawerTitle>
                      <DrawerDescription>
                        Side drawers keep dense server metadata close to the inventory table.
                      </DrawerDescription>
                    </DrawerHeader>
                    <div className="grid gap-3 px-4 pb-4">
                      <div className="grid gap-2">
                        <Label>Transport</Label>
                        <Badge variant="ghost">http</Badge>
                      </div>
                      <div className="grid gap-2">
                        <Label>Target</Label>
                        <code className="rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">
                          https://api.githubcopilot.com/mcp/
                        </code>
                      </div>
                      <div className="grid gap-2">
                        <Label>Status</Label>
                        <StatusBadge status="needs auth" />
                      </div>
                      <Button variant="outline">
                        <KeyRound />
                        Authorize
                      </Button>
                    </div>
                  </DrawerContent>
                </Drawer>
                <Sheet>
                  <SheetTrigger render={<Button variant="outline" />}>Open sheet</SheetTrigger>
                  <SheetContent>
                    <SheetHeader>
                      <SheetTitle>Server details</SheetTitle>
                      <SheetDescription>Side panel for dense metadata.</SheetDescription>
                    </SheetHeader>
                  </SheetContent>
                </Sheet>
                <FamilyDrawerRoot views={cultFamilyDrawerViews}>
                  <FamilyDrawerTrigger className="static h-8 -translate-x-0 -translate-y-0 rounded-lg border-transparent bg-primary px-2.5 py-0 text-sm text-primary-foreground shadow-xs hover:bg-primary/90">
                    Cult family drawer
                  </FamilyDrawerTrigger>
                  <FamilyDrawerContent>
                    <FamilyDrawerClose />
                    <FamilyDrawerAnimatedWrapper>
                      <FamilyDrawerAnimatedContent>
                        <FamilyDrawerViewContent />
                      </FamilyDrawerAnimatedContent>
                    </FamilyDrawerAnimatedWrapper>
                  </FamilyDrawerContent>
                </FamilyDrawerRoot>
              </div>
            </div>
          </ComponentTile>

          <ComponentTile title="Installed inventory">
            <div className="flex flex-wrap gap-2">
              {[
                "combobox",
                "direction",
                "sidebar",
                "sonner",
                "toast",
                "dialog",
                "alert dialog",
                "separator",
              ].map((name) => (
                <Badge key={name} variant="outline">
                  {name}
                </Badge>
              ))}
            </div>
          </ComponentTile>
        </div>
      </DirectionProvider>
    </TooltipProvider>
  );
}

function ComponentTile(props: { children: ReactNode; title: string }) {
  return (
    <section className="grid min-w-0 gap-3 border-border border-t pt-3">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{props.title}</h3>
      <div className="min-w-0">{props.children}</div>
    </section>
  );
}

function DotLoaderExample(props: { children: ReactNode; label: string }) {
  return (
    <div className="grid min-h-24 place-items-center gap-2 rounded-md bg-muted/35 p-3">
      {props.children}
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
    </div>
  );
}
