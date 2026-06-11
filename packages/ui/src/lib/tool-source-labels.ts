import type { AuthStatus } from "@/App";

export type ToolSourceType = "stdio" | "http" | "sse";

export const TOOL_SOURCE_TYPE_LABELS: Record<ToolSourceType, string> = {
  http: "HTTP",
  sse: "SSE",
  stdio: "Stdio",
};

export const AUTH_STATUS_LABELS: Record<AuthStatus, string> = {
  "needs auth": "Needs auth",
  expired: "Expired",
  "n/a": "No auth",
  ok: "Ready",
};

export function toolSourceTypeLabel(type: ToolSourceType) {
  return TOOL_SOURCE_TYPE_LABELS[type];
}

export function authStatusLabel(status: AuthStatus) {
  return AUTH_STATUS_LABELS[status];
}
