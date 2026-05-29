import {
  Download,
  Info,
  KeyRound,
  LinkIcon,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Undo2,
} from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import "./App.css";

type RatelScope = "user" | "project" | "local";
type AuthStatus = "n/a" | "needs auth" | "expired" | "ok";

interface ServerEntry {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  scope?: string;
  [key: string]: unknown;
}

interface RatelConfig {
  mcpServers: Record<string, ServerEntry>;
}

interface BackupManifest {
  createdAt: string;
  action: "import" | "add" | "remove" | "edit" | "link";
  entries: Array<{ originalPath: string; backupPath: string; existedBefore: boolean }>;
}

type ScopeState =
  | {
      available: true;
      path: string;
      config: RatelConfig;
      authStatus: Record<string, AuthStatus>;
    }
  | { available: false };

interface ConfigResponse {
  homeDir: string;
  projectRoot: string | null;
  scopes: Record<RatelScope, ScopeState>;
  backups: BackupManifest[];
}

type Modal =
  | { kind: "details"; name: string; entry: ServerEntry }
  | { kind: "add" }
  | { kind: "edit"; name: string; entry: ServerEntry };
type ConfirmRequest = {
  actionLabel: string;
  description: string;
  onConfirm: () => void | Promise<void>;
  title: string;
  variant?: "default" | "destructive";
};
type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };

const SCOPES: RatelScope[] = ["user", "project", "local"];

function App() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get("t") ?? "", []);
  const [scope, setScope] = useState<RatelScope>("user");
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);

  const notify = useCallback((message: string, kind?: "error") => {
    const [title, ...description] = message.split("\n");
    const options = { description: description.join("\n") || undefined };
    if (kind === "error") {
      toast.error(title, options);
      return;
    }
    toast.success(title, options);
  }, []);

  const request = useCallback(
    async <T,>(path: string, init: JsonRequestInit = {}): Promise<T> => {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const body =
        init.body === undefined
          ? undefined
          : typeof init.body === "string"
            ? init.body
            : JSON.stringify(init.body);
      if (body !== undefined && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      const res = await fetch(path, { ...init, headers, body });
      const payload = await readJson(res);
      if (!res.ok) {
        const message =
          payload && typeof payload.error === "string"
            ? payload.error
            : `${res.status} ${res.statusText}`;
        throw new Error(message);
      }
      return payload as T;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    try {
      setConfig(await request<ConfigResponse>("/api/config"));
    } catch (err) {
      notify((err as Error).message, "error");
    }
  }, [notify, request]);

  useEffect(() => {
    if (token) void refresh();
  }, [refresh, token]);

  const runAction = useCallback(
    async (label: string, action: () => Promise<{ log?: string[] } | unknown>) => {
      setBusy(true);
      try {
        const result = await action();
        const log = isLogResult(result) ? result.log.slice(-3).join("\n") : "";
        notify(log ? `${label}\n${log}` : label);
        await refresh();
      } catch (err) {
        notify((err as Error).message, "error");
      } finally {
        setBusy(false);
      }
    },
    [notify, refresh],
  );

  if (!token) {
    return (
      <>
        <main className="mx-auto max-w-5xl px-6 py-6">
          <Alert>
            <AlertTitle>Missing session token</AlertTitle>
            <AlertDescription>Open the URL printed by ratel-mcp ui.</AlertDescription>
          </Alert>
        </main>
        <Toaster />
      </>
    );
  }

  const scopeData = config?.scopes[scope];
  const servers = scopeData?.available ? scopeData.config.mcpServers : {};
  const names = Object.keys(servers);

  return (
    <>
      <header className="border-border border-b bg-background px-6 py-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-2">
          <h1 className="font-heading text-3xl leading-none font-semibold text-primary">
            Ratel MCP
          </h1>
          <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted-foreground">
            <span>home: {config?.homeDir ?? ""}</span>
            <span>
              {config?.projectRoot ? `project: ${config.projectRoot}` : "no project root"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-4 px-6 py-6">
        <Tabs value={scope} onValueChange={(value) => setScope(value as RatelScope)}>
          <TabsList variant="line" className="border-border w-full justify-start border-b">
            {SCOPES.map((item) => (
              <TabsTrigger
                className="font-mono text-[11px] tracking-[0.14em] uppercase data-active:text-primary"
                key={item}
                value={item}
              >
                {item}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <Card>
          <CardHeader>
            <CardTitle className="capitalize">{scope}</CardTitle>
            <CardDescription>
              {scopeData?.available ? scopeData.path : "scope unavailable"}
            </CardDescription>
            <CardAction className="flex gap-2">
              <Button aria-label="Refresh" onClick={refresh} size="icon" title="Refresh">
                <RefreshCw />
              </Button>
              <Button
                aria-label="Add server"
                disabled={!scopeData?.available}
                onClick={() => setModal({ kind: "add" })}
                size="icon"
                title="Add server"
              >
                <Plus />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {!scopeData?.available ? (
              <EmptyState>Scope not available.</EmptyState>
            ) : names.length === 0 ? (
              <EmptyState>No servers in this scope.</EmptyState>
            ) : (
              <div className="divide-border divide-y">
                {names.map((name) => {
                  const entry = servers[name];
                  const authStatus = scopeData.authStatus[name];
                  return (
                    <div
                      className="flex min-h-16 items-center justify-between gap-4 py-3 max-md:block"
                      key={name}
                    >
                      <div className="min-w-0">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <strong className="font-medium">{name}</strong>
                          <AuthBadge status={authStatus} />
                        </div>
                        <code className="block max-w-full overflow-hidden rounded-md border bg-primary px-2 py-1 font-mono text-xs text-primary-foreground text-ellipsis whitespace-nowrap">
                          {summaryOf(entry)}
                        </code>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 max-md:mt-3">
                        <Button
                          aria-label="Details"
                          onClick={() => setModal({ kind: "details", name, entry })}
                          size="icon"
                          title="Details"
                          variant="outline"
                        >
                          <Info />
                        </Button>
                        <Button
                          aria-label="Edit"
                          onClick={() => setModal({ kind: "edit", name, entry })}
                          size="icon"
                          title="Edit"
                          variant="outline"
                        >
                          <Pencil />
                        </Button>
                        {(entry.type === "http" || entry.type === "sse") && (
                          <Button
                            aria-label="Authorize"
                            disabled={busy}
                            onClick={() =>
                              runAction("Auth complete", () =>
                                request(`/api/auth/${encodeURIComponent(name)}`, {
                                  method: "POST",
                                  body: {},
                                }),
                              )
                            }
                            size="icon"
                            title="Authorize"
                            variant="outline"
                          >
                            <KeyRound />
                          </Button>
                        )}
                        <Button
                          aria-label="Remove"
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              actionLabel: "Remove",
                              description: `Remove "${name}" from the ${scope} scope?`,
                              title: "Remove server",
                              variant: "destructive",
                              onConfirm: () =>
                                runAction(`Removed ${name}`, () =>
                                  request(`/api/servers/${encodeURIComponent(name)}`, {
                                    method: "DELETE",
                                    body: { scope },
                                  }),
                                ),
                            })
                          }
                          size="icon"
                          title="Remove"
                          variant="destructive"
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <section className="grid gap-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Agent interop</CardTitle>
              <CardDescription>Import native entries or link an agent to Ratel.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    actionLabel: "Import",
                    description: "Import all detected agent MCP servers into Ratel?",
                    title: "Import agent MCP servers",
                    onConfirm: () =>
                      runAction("Import complete", () =>
                        request("/api/import", { method: "POST", body: {} }),
                      ),
                  })
                }
                variant="outline"
              >
                <Download />
                Import
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  setConfirm({
                    actionLabel: "Link",
                    description: "Rewrite the detected agent to point at Ratel?",
                    title: "Link agent to Ratel",
                    onConfirm: () =>
                      runAction("Link complete", () =>
                        request("/api/link", { method: "POST", body: {} }),
                      ),
                  })
                }
                variant="outline"
              >
                <LinkIcon />
                Link
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Backups</CardTitle>
              <CardDescription>Latest snapshots created by write operations.</CardDescription>
            </CardHeader>
            <CardContent>
              {!config?.backups.length ? (
                <EmptyState compact>No backups.</EmptyState>
              ) : (
                <div className="grid gap-2">
                  {config.backups.map((backup, index) => (
                    <div
                      className="border-border flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0 max-md:block"
                      key={`${backup.createdAt}-${backup.action}`}
                    >
                      <div className="min-w-0">
                        <strong className="font-medium">
                          {backup.action} · {backup.createdAt}
                        </strong>
                        <p className="truncate text-xs text-muted-foreground">
                          {backup.entries.map((entry) => entry.originalPath).join(", ")}
                        </p>
                      </div>
                      {index === 0 && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              actionLabel: "Restore",
                              description: "Restore files from the latest backup?",
                              title: "Undo latest backup",
                              onConfirm: () =>
                                runAction("Undo complete", () =>
                                  request("/api/backups/undo", { method: "POST", body: {} }),
                                ),
                            })
                          }
                          size="sm"
                          variant="outline"
                        >
                          <Undo2 />
                          Undo
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>

      <Dialog open={modal !== null} onOpenChange={(open) => !open && setModal(null)}>
        {modal?.kind === "details" && (
          <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Server: {modal.name}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-[60vh] overflow-auto rounded-md border bg-primary p-3 font-mono text-xs text-primary-foreground">
              {JSON.stringify(modal.entry, null, 2)}
            </pre>
          </DialogContent>
        )}

        {(modal?.kind === "add" || modal?.kind === "edit") && (
          <EntryModal
            entry={modal.kind === "edit" ? modal.entry : undefined}
            name={modal.kind === "edit" ? modal.name : undefined}
            onClose={() => setModal(null)}
            onSubmit={async (name, entry) => {
              const path =
                modal.kind === "edit" ? `/api/servers/${encodeURIComponent(name)}` : "/api/servers";
              const body = modal.kind === "edit" ? { scope, entry } : { scope, name, entry };
              await runAction(modal.kind === "edit" ? `Updated ${name}` : `Added ${name}`, () =>
                request(path, {
                  method: modal.kind === "edit" ? "PATCH" : "POST",
                  body,
                }),
              );
              setModal(null);
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <Toaster />
    </>
  );
}

function EntryModal(props: {
  entry?: ServerEntry;
  name?: string;
  onClose: () => void;
  onSubmit: (name: string, entry: ServerEntry) => Promise<void>;
}) {
  const id = useId();
  const [name, setName] = useState(props.name ?? "");
  const [type, setType] = useState(props.entry?.type ?? "stdio");
  const [description, setDescription] = useState(props.entry?.description ?? "");
  const [command, setCommand] = useState(props.entry?.command ?? "");
  const [args, setArgs] = useState((props.entry?.args ?? []).join("\n"));
  const [env, setEnv] = useState(keyValsToText(props.entry?.env, "="));
  const [cwd, setCwd] = useState(props.entry?.cwd ?? "");
  const [url, setUrl] = useState(props.entry?.url ?? "");
  const [headers, setHeaders] = useState(keyValsToText(props.entry?.headers, ": "));
  const [clientId, setClientId] = useState(props.entry?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState(props.entry?.clientSecret ?? "");
  const [callbackPort, setCallbackPort] = useState(
    props.entry?.callbackPort === undefined ? "" : String(props.entry.callbackPort),
  );
  const [oauthScope, setOauthScope] = useState(props.entry?.scope ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    try {
      await props.onSubmit(trimmedName, buildEntry());
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function buildEntry(): ServerEntry {
    const entry: ServerEntry = { type };
    if (description.trim()) entry.description = description.trim();
    if (type === "stdio") {
      if (command.trim()) entry.command = command.trim();
      const parsedArgs = lines(args);
      if (parsedArgs.length) entry.args = parsedArgs;
      const parsedEnv = parseKeyValueLines(env, "=");
      if (Object.keys(parsedEnv).length) entry.env = parsedEnv;
      if (cwd.trim()) entry.cwd = cwd.trim();
      return entry;
    }

    if (url.trim()) entry.url = url.trim();
    const parsedHeaders = parseKeyValueLines(headers, ":");
    if (Object.keys(parsedHeaders).length) entry.headers = parsedHeaders;
    if (clientId.trim()) entry.clientId = clientId.trim();
    if (clientSecret.trim()) entry.clientSecret = clientSecret.trim();
    if (callbackPort.trim()) {
      const parsed = Number(callbackPort);
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
        entry.callbackPort = parsed;
      }
    }
    if (oauthScope.trim()) entry.scope = oauthScope.trim();
    return entry;
  }

  return (
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{props.name ? `Edit ${props.name}` : "Add server"}</DialogTitle>
      </DialogHeader>
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-3">
          {!props.name && (
            <Field label="Name" name={`${id}-name`}>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          )}

          <Field label="Type" name={`${id}-type`}>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id={`${id}-type`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">stdio</SelectItem>
                <SelectItem value="http">http</SelectItem>
                <SelectItem value="sse">sse</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label="Description" name={`${id}-description`}>
            <Textarea
              id={`${id}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          {type === "stdio" ? (
            <>
              <Field label="Command" name={`${id}-command`}>
                <Input
                  id={`${id}-command`}
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </Field>
              <Field label="Args" name={`${id}-args`}>
                <Textarea
                  id={`${id}-args`}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </Field>
              <Field label="Env" name={`${id}-env`}>
                <Textarea
                  id={`${id}-env`}
                  value={env}
                  onChange={(event) => setEnv(event.target.value)}
                />
              </Field>
              <Field label="CWD" name={`${id}-cwd`}>
                <Input
                  id={`${id}-cwd`}
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL" name={`${id}-url`}>
                <Input
                  id={`${id}-url`}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
              <Field label="Headers" name={`${id}-headers`}>
                <Textarea
                  id={`${id}-headers`}
                  value={headers}
                  onChange={(event) => setHeaders(event.target.value)}
                />
              </Field>
              <Field label="OAuth client_id" name={`${id}-client-id`}>
                <Input
                  id={`${id}-client-id`}
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </Field>
              <Field label="OAuth client_secret" name={`${id}-client-secret`}>
                <Input
                  id={`${id}-client-secret`}
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </Field>
              <Field label="OAuth callback port" name={`${id}-callback-port`}>
                <Input
                  id={`${id}-callback-port`}
                  value={callbackPort}
                  onChange={(event) => setCallbackPort(event.target.value)}
                />
              </Field>
              <Field label="OAuth scope" name={`${id}-oauth-scope`}>
                <Input
                  id={`${id}-oauth-scope`}
                  value={oauthScope}
                  onChange={(event) => setOauthScope(event.target.value)}
                />
              </Field>
            </>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not save server</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button onClick={props.onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button type="submit">{props.name ? "Save" : "Add"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
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

function ConfirmDialog(props: { request: ConfirmRequest | null; onClose: () => void }) {
  const request = props.request;
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && props.onClose()}>
      {request && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{request.title}</AlertDialogTitle>
            <AlertDialogDescription>{request.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void Promise.resolve(request.onConfirm()).finally(props.onClose);
              }}
              variant={request.variant === "destructive" ? "destructive" : "default"}
            >
              {request.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}

function EmptyState(props: { children: ReactNode; compact?: boolean }) {
  return (
    <div
      className={
        props.compact ? "text-sm text-muted-foreground" : "py-4 text-sm text-muted-foreground"
      }
    >
      {props.children}
    </div>
  );
}

function AuthBadge({ status }: { status?: AuthStatus }) {
  if (!status || status === "n/a") return null;
  if (status === "ok") {
    return (
      <Badge variant="outline" className="border-primary text-primary">
        ok
      </Badge>
    );
  }
  if (status === "expired") {
    return <Badge variant="secondary">expired</Badge>;
  }
  return <Badge variant="destructive">needs auth</Badge>;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isLogResult(value: unknown): value is { log: string[] } {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as { log?: unknown }).log)
  );
}

function summaryOf(entry: ServerEntry): string {
  const type = entry.type || "stdio";
  if (type === "stdio") {
    const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
    return `[${type}] ${entry.command ?? "<no command>"}${args}`;
  }
  return `[${type}] ${entry.url ?? "<no url>"}`;
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseKeyValueLines(value: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

function keyValsToText(value: Record<string, string> | undefined, separator: string): string {
  return Object.entries(value ?? {})
    .map(([key, val]) => `${key}${separator}${val}`)
    .join("\n");
}

export default App;
