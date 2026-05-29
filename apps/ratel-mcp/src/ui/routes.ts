import {
  type AuthFlowResult,
  addServerEntry,
  assertRatelScope,
  authorizeServer,
  editServerEntry,
  getConfigState,
  importAgentServers,
  linkAgentToRatel,
  removeServerEntry,
  type ServerEntry,
  undoLatestBackup,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "../cli/handlers/types.js";

export interface ApiResponse {
  status: number;
  body: unknown;
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function withCapture<T>(
  base: HandlerCtx,
  fn: (ctx: HandlerCtx) => Promise<T>,
): Promise<{ result: T; log: string[] }> {
  const log: string[] = [];
  const ctx: HandlerCtx = {
    ...base,
    log: (m) => log.push(m),
  };
  return fn(ctx).then((result) => ({ result, log }));
}

export async function getConfig(ctx: HandlerCtx): Promise<ApiResponse> {
  return ok(await getConfigState(ctx));
}

export async function addServer(
  ctx: HandlerCtx,
  body: { scope?: unknown; name?: unknown; entry?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new Error("name is required");
  const entry = (body.entry as ServerEntry) ?? {};
  const result = await addServerEntry(ctx, { scope, name, entry });
  return ok({ name, scope, path: result.path });
}

export async function editServer(
  ctx: HandlerCtx,
  name: string,
  body: { scope?: unknown; entry?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const entry = body.entry as ServerEntry;
  const result = await editServerEntry(ctx, { scope, name, entry });
  return ok({ name, scope, path: result.path });
}

export async function removeServer(
  ctx: HandlerCtx,
  name: string,
  body: { scope?: unknown },
): Promise<ApiResponse> {
  const scope = assertRatelScope(body.scope);
  const result = await removeServerEntry(ctx, { scope, name });
  return ok({ name, scope, path: result.path });
}

export async function authServer(ctx: HandlerCtx, name: string): Promise<ApiResponse> {
  if (!name) throw new Error("name is required");
  const { result, log } = await withCapture(ctx, (c) => authorizeServer(c, name));
  log.push(...formatAuthResults(result));
  return ok({ log });
}

function resolveRatelBin(): string | undefined {
  if (process.env.RATEL_MCP_BIN) return process.env.RATEL_MCP_BIN;
  if (process.argv[1]) return process.argv[1];
  return undefined;
}

export async function doImport(ctx: HandlerCtx): Promise<ApiResponse> {
  const { log } = await withCapture(ctx, (c) =>
    importAgentServers(c, { envVar: resolveRatelBin() }).then(() => undefined),
  );
  return ok({ log });
}

export async function doLink(ctx: HandlerCtx): Promise<ApiResponse> {
  const { log } = await withCapture(ctx, (c) =>
    linkAgentToRatel(c, { envVar: resolveRatelBin() }).then(() => undefined),
  );
  return ok({ log });
}

export async function undoLatest(ctx: HandlerCtx): Promise<ApiResponse> {
  const restored = await undoLatestBackup(ctx);
  if (!restored) return ok({ log: ["nothing to undo"] });
  const log = restored.entries.map((e) => `restored ${e.originalPath}`);
  return ok({ log });
}

function formatAuthResults(results: AuthFlowResult[]): string[] {
  if (results.length === 0) return ["[ratel] no upstreams to authorize"];
  return results.map((r) => {
    const annotation =
      r.status === "authorized" && r.mode
        ? ` (${r.mode === "refresh" ? "refreshed" : "re-authed"})`
        : "";
    const tail = r.reason ? `: ${r.reason}` : "";
    return `${r.name.padEnd(20)} ${r.status}${annotation}${tail}`;
  });
}
