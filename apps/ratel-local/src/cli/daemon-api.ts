import { join } from "node:path";
import { daemonPaths } from "./handlers/daemon.js";
import type { HandlerCtx } from "./handlers/types.js";

export type DaemonApiRequest = (
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<Response | null>;

/**
 * Call the loopback daemon when its persisted state and credential are both
 * present. A missing or unreachable daemon is deliberately reported as null so
 * CLI commands can use their offline control-plane fallback. Once an HTTP
 * response is received, callers must not fall back: even an error response is
 * authoritative and can carry a CAS/validation conflict.
 */
export async function requestRunningDaemon(
  ctx: HandlerCtx,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response | null> {
  if (typeof ctx.fs.read !== "function") return null;
  const stateText = await ctx.fs.read(daemonPaths(ctx.env.homeDir).state);
  const daemonToken = await ctx.fs.read(join(ctx.env.homeDir, ".ratel", "daemon-token"));
  if (!stateText || !daemonToken?.trim()) return null;

  let state: { uiUrl?: unknown; port?: unknown };
  try {
    state = JSON.parse(stateText) as { uiUrl?: unknown; port?: unknown };
  } catch {
    return null;
  }
  const baseUrl =
    typeof state.uiUrl === "string"
      ? state.uiUrl
      : typeof state.port === "number"
        ? `http://127.0.0.1:${state.port}`
        : undefined;
  if (!baseUrl) return null;

  try {
    return await fetch(new URL(path, baseUrl), {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${daemonToken.trim()}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    return null;
  }
}

export async function requireDaemonJson<T>(response: Response, operation: string): Promise<T> {
  const body = (await response.json().catch(() => null)) as
    | ({ error?: unknown } & Record<string, unknown>)
    | null;
  if (!response.ok) {
    throw new Error(
      body && typeof body.error === "string"
        ? body.error
        : `${operation} failed: HTTP ${response.status}`,
    );
  }
  if (!body) throw new Error(`${operation} returned an invalid JSON response`);
  return body as T;
}
