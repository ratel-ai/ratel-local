import { RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRatelApp } from "@/App";
import { EmptyStateIcon } from "@/components/empty-state-icon";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderBackRow,
  PageHeaderContent,
  PageHeaderDescription,
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
  name?: string;
  version?: string;
  protocolVersion?: string;
  connectedAt: string;
  lastSeenAt: string;
  requestCount?: number;
  title?: string;
  userAgent?: string;
  remoteAddress?: string;
  capabilities?: string[];
  agentHost?: "claude-code" | "codex";
  linkScope?: "user" | "project" | "local";
  runtimeRevision?: string;
  stale?: boolean;
}

interface ClientsResponse {
  clients: ActiveMcpClient[];
}

export function McpClientsPage() {
  const { request } = useRatelApp();
  const [clients, setClients] = useState<ActiveMcpClient[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const staleClients = clients.filter((client) => client.stale);

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
            </div>
          </PageHeaderBackRow>
          <PageHeaderDescription>
            Active streamable HTTP sessions connected to this daemon.
          </PageHeaderDescription>
        </PageHeaderContent>
        <PageHeaderActions className="hidden sm:flex">
          <ResponsiveToolbar>
            <ResponsiveToolbarGroup>
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

      {staleClients.length > 0 && (
        <Alert className="border-amber-500/40 bg-amber-500/10">
          <TriangleAlert className="text-amber-600" />
          <AlertTitle>Reconnect required</AlertTitle>
          <AlertDescription>
            {staleClients.length} client{staleClients.length === 1 ? " is" : "s are"} still using an
            older runtime revision. Reconnect those clients to receive the current configuration.
          </AlertDescription>
        </Alert>
      )}

      {clients.length === 0 ? (
        <section className="grid min-h-72 place-items-center rounded-2xl border border-forest-300 border-dashed bg-forest-600/20 px-6 text-center">
          <div className="grid max-w-sm gap-2">
            <EmptyStateIcon>
              <Unplug />
            </EmptyStateIcon>
            <h2 className="font-medium">No active MCP clients</h2>
            <p className="text-sm text-muted-foreground">
              No initialized sessions are currently open.
            </p>
          </div>
        </section>
      ) : (
        <section className="overflow-hidden rounded-2xl border border-forest-300 bg-forest-600/40">
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
                      <span className="flex items-center gap-2 font-medium">
                        {client.title ?? client.agentHost ?? client.name ?? "MCP client"}
                        {client.stale && <Badge variant="warning">Stale</Badge>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {[client.name, client.version, client.linkScope]
                          .filter(Boolean)
                          .join(" ") || "Connected through Ratel"}
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
                    <Badge variant="outline">{client.protocolVersion ?? "MCP"}</Badge>
                  </TableCell>
                  <TableCell className="max-w-72">
                    <div className="flex flex-wrap gap-1">
                      {(client.capabilities?.length ?? 0) === 0 ? (
                        <span className="text-xs text-muted-foreground">None</span>
                      ) : (
                        client.capabilities?.map((capability) => (
                          <Badge key={capability} variant="secondary">
                            {capability}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {client.requestCount ?? 0}
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
