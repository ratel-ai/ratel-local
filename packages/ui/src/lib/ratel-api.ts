import { contextualizeApiPath, type RuntimeUiContext } from "@/lib/runtime-context";

export type JsonRequestInit = Omit<RequestInit, "body"> & { body?: unknown };

export interface RatelApiSession {
  context: RuntimeUiContext;
  token: string;
}

export async function requestRatelApi<T>(
  session: RatelApiSession,
  path: string,
  init: JsonRequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.token}`);
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === "string"
        ? init.body
        : JSON.stringify(init.body);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const requestPath = contextualizeApiPath(path, session.context, init.method ?? "GET");
  const response = await fetch(requestPath, { ...init, headers, body });
  const payload = await readJson(response);
  if (!response.ok) {
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return payload as T;
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
