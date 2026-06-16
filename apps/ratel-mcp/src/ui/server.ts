import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { HandlerCtx } from "../cli/handlers/types.js";
import {
  type ApiResponse,
  activateSkillsRoute,
  addServer,
  applyImportAgent,
  applyImportRatel,
  applyLink,
  authServer,
  createSkillRoute,
  deactivateSkillsRoute,
  doImport,
  doLink,
  editServer,
  getAgentHosts,
  getConfig,
  getSkills,
  openFile,
  previewImport,
  previewLink,
  removeServer,
} from "./routes.js";
import {
  constantTimeEqual,
  extractBearer,
  extractTokenFromUrl,
  isLoopbackHost,
  UI_HOST,
} from "./security.js";

export interface StartUiServerOptions {
  ctx: HandlerCtx;
  token: string;
  port?: number;
  assetDir?: string;
}

export interface UiServerHandle {
  url: string;
  port: number;
  shutdown(): Promise<void>;
}

export async function startUiServer(opts: StartUiServerOptions): Promise<UiServerHandle> {
  const server = createHttpServer((req, res) => {
    handleRequest(req, res, opts).catch((err) => {
      writeJson(res, 500, { error: (err as Error).message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, UI_HOST, () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://${UI_HOST}:${port}/?t=${opts.token}`;

  return {
    url,
    port,
    shutdown: () => closeServer(server),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartUiServerOptions,
): Promise<void> {
  const port = (req.socket.localPort as number | undefined) ?? 0;

  if (!isLoopbackHost(req.headers.host, port)) {
    writePlain(res, 400, "Invalid Host header");
    return;
  }

  const url = req.url ?? "/";
  const path = url.split("?")[0];

  if (req.method === "GET" && !path.startsWith("/api/")) {
    if (hasFileExtension(path)) {
      await writeStaticAsset(res, opts.assetDir ?? defaultUiAssetDir(), path);
      return;
    }

    const queryToken = extractTokenFromUrl(url);
    if (!queryToken || !constantTimeEqual(queryToken, opts.token)) {
      writePlain(res, 401, "Unauthorized");
      return;
    }
    await writeStaticAsset(res, opts.assetDir ?? defaultUiAssetDir(), "/index.html");
    return;
  }

  const bearer = extractBearer(req.headers.authorization);
  if (!bearer || !constantTimeEqual(bearer, opts.token)) {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  try {
    const response = await route(req, path, opts.ctx);
    if (!response) {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    writeJson(res, response.status, response.body);
  } catch (err) {
    writeJson(res, 400, { error: (err as Error).message });
  }
}

async function route(
  req: IncomingMessage,
  path: string,
  ctx: HandlerCtx,
): Promise<ApiResponse | null> {
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/config") {
    return getConfig(ctx);
  }
  if (method === "GET" && path === "/api/agent-hosts") {
    return getAgentHosts(ctx);
  }
  if (method === "GET" && path === "/api/skills") {
    return getSkills(ctx);
  }
  if (method === "POST" && path === "/api/skills") {
    const body = await readJsonBody(req);
    return createSkillRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/skills/activate") {
    const body = await readJsonBody(req);
    return activateSkillsRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/skills/deactivate") {
    const body = await readJsonBody(req);
    return deactivateSkillsRoute(ctx, body);
  }
  if (method === "POST" && path === "/api/open-file") {
    const body = await readJsonBody(req);
    return openFile(ctx, body);
  }
  if (method === "POST" && path === "/api/servers") {
    const body = await readJsonBody(req);
    return addServer(ctx, body);
  }

  const serverMatch = /^\/api\/servers\/([^/]+)$/.exec(path);
  if (serverMatch) {
    const name = decodeURIComponent(serverMatch[1]);
    if (method === "PATCH") {
      const body = await readJsonBody(req);
      return editServer(ctx, name, body);
    }
    if (method === "DELETE") {
      const body = await readJsonBody(req);
      return removeServer(ctx, name, body);
    }
  }

  const authMatch = /^\/api\/auth\/([^/]+)$/.exec(path);
  if (method === "POST" && authMatch) {
    const name = decodeURIComponent(authMatch[1]);
    return authServer(ctx, name);
  }

  if (method === "POST" && path === "/api/import") {
    return doImport(ctx);
  }
  if (method === "POST" && path === "/api/link") {
    return doLink(ctx);
  }
  if (method === "POST" && path === "/api/agent-preview/import") {
    const body = await readJsonBody(req);
    return previewImport(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-preview/link") {
    const body = await readJsonBody(req);
    return previewLink(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-apply/import/ratel") {
    const body = await readJsonBody(req);
    return applyImportRatel(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-apply/import/agent") {
    const body = await readJsonBody(req);
    return applyImportAgent(ctx, body);
  }
  if (method === "POST" && path === "/api/agent-apply/link") {
    const body = await readJsonBody(req);
    return applyLink(ctx, body);
  }
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) {
      throw new Error("request body too large");
    }
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("request body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid JSON body: ${(err as Error).message}`);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writePlain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function defaultUiAssetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ui");
}

function hasFileExtension(path: string): boolean {
  const last = path.split("/").at(-1) ?? "";
  return last.includes(".");
}

async function writeStaticAsset(
  res: ServerResponse,
  assetDir: string,
  requestPath: string,
): Promise<void> {
  const assetPath = resolveAssetPath(assetDir, requestPath);
  if (!assetPath) {
    writePlain(res, 404, "Not Found");
    return;
  }

  try {
    const info = await stat(assetPath);
    if (!info.isFile()) {
      writePlain(res, 404, "Not Found");
      return;
    }
  } catch {
    writePlain(res, 404, "Not Found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentTypeFor(assetPath) });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(assetPath);
    stream.once("error", reject);
    stream.once("end", resolve);
    stream.pipe(res);
  });
}

function resolveAssetPath(assetDir: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath.split("?")[0] ?? requestPath);
  } catch {
    return null;
  }
  const relative = normalize(decoded.replace(/^\/+/, ""));
  if (relative === ".." || relative.startsWith(`..${sep}`) || relative.startsWith("/")) {
    return null;
  }
  return join(assetDir, relative || "index.html");
}

function contentTypeFor(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
