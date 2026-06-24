import { RefreshCw, SearchIcon, Unplug } from "lucide-react";
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
import {
  ResponsiveToolbar,
  ResponsiveToolbarButton,
  ResponsiveToolbarGroup,
} from "@/components/responsive-toolbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ActiveMcpClient {
  sessionId: string;
  name: string;
  version: string;
  protocolVersion: string;
  connectedAt: string;
  lastSeenAt: string;
  requestCount: number;
  title?: string;
  userAgent?: string;
  remoteAddress?: string;
  capabilities: string[];
}

interface ClientsResponse {
  clients: ActiveMcpClient[];
}

export function McpClientsPage() {
  const { openCommandMenu, request } = useRatelApp();
  const [clients, setClients] = useState<ActiveMcpClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const body = await request<ClientsResponse>("/api/mcp-clients");
      setClients(body.clients);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="grid w-full gap-4 px-4 py-5 sm:px-6">
      <PageHeader className="sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <PageHeaderContent>
          <PageHeaderBackRow>
            <PageHeaderTitle>MCP Clients</PageHeaderTitle>
            <div className="flex items-center gap-1 sm:hidden">
              <ButtonGroup>
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
                <Button
                  aria-label="Refresh clients"
                  disabled={loading}
                  onClick={() => void refresh()}
                  size="icon-lg"
                  type="button"
                  variant="outline"
                >
                  {loading ? <Spinner /> : <RefreshCw />}
                  <span className="sr-only">Refresh clients</span>
                </Button>
              </ButtonGroup>
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Active streamable HTTP sessions connected to this daemon.
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
                disabled={loading}
                icon={loading ? <Spinner /> : <RefreshCw />}
                label="Refresh clients"
                onClick={() => void refresh()}
              />
            </ResponsiveToolbarGroup>
          </ResponsiveToolbar>
        </PageHeaderActions>
      </PageHeader>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Could not load clients</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {clients.length === 0 ? (
        <section className="grid min-h-72 place-items-center rounded-lg border border-dashed bg-muted/20 px-6 text-center">
          <div className="grid max-w-sm gap-2">
            <Unplug className="mx-auto size-7 text-muted-foreground" />
            <h2 className="font-medium">No active MCP clients</h2>
            <p className="text-sm text-muted-foreground">
              No initialized sessions are currently open.
            </p>
          </div>
        </section>
      ) : (
        <section className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead>Last Seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.sessionId}>
                  <TableCell className="min-w-48">
                    <div className="grid gap-0.5">
                      <span className="font-medium">{client.title ?? client.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {client.name} {client.version}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-52">
                    <code className="block truncate font-mono text-xs">{client.sessionId}</code>
                    <span className="block truncate text-xs text-muted-foreground">
                      {client.remoteAddress ?? client.userAgent ?? "loopback"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{client.protocolVersion}</Badge>
                  </TableCell>
                  <TableCell className="max-w-72">
                    <div className="flex flex-wrap gap-1">
                      {client.capabilities.length === 0 ? (
                        <span className="text-xs text-muted-foreground">None</span>
                      ) : (
                        client.capabilities.map((capability) => (
                          <Badge key={capability} variant="secondary">
                            {capability}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {client.requestCount}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelativeTime(client.lastSeenAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </main>
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}
