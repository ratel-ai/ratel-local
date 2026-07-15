export type RuntimeUiContext =
  | { kind: "all" }
  | { kind: "global" }
  | { kind: "project"; projectId: string };

export type MutationScopeTarget =
  | { scope: "user" }
  | { scope: "project" | "local"; projectId: string };

const CONTEXT_FREE_API_PATHS = new Set(["/api/projects", "/api/daemon/status", "/api/ui/sessions"]);

const LEGACY_PREFIXES = ["/tools", "/skills", "/clients", "/agent-setup"] as const;

export function runtimeContextFromPathname(pathname: string): RuntimeUiContext {
  if (pathname === "/all" || pathname.startsWith("/all/")) return { kind: "all" };
  if (pathname === "/global" || pathname.startsWith("/global/")) return { kind: "global" };

  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (match) {
    return { kind: "project", projectId: safelyDecodePathSegment(match[1]) };
  }

  // Legacy routes behave as global until AppShell replaces their URL.
  return { kind: "global" };
}

export function contextBasePath(context: RuntimeUiContext): string {
  if (context.kind === "all") return "/all";
  if (context.kind === "global") return "/global";
  return `/projects/${encodeURIComponent(context.projectId)}`;
}

export function contextPagePath(context: RuntimeUiContext, page: string): string {
  const base = contextBasePath(context);
  if (context.kind === "all") return base;
  const normalizedPage = page === "/" ? "" : `/${page.replace(/^\/+|\/+$/g, "")}`;
  return `${base}${normalizedPage}`;
}

export function pageSuffixFromPathname(pathname: string): string {
  if (pathname === "/all" || pathname.startsWith("/all/")) return "/";
  if (pathname === "/global") return "/";
  if (pathname.startsWith("/global/")) return pathname.slice("/global".length);

  const projectMatch = /^\/projects\/[^/]+(\/.*)?$/.exec(pathname);
  if (projectMatch) return projectMatch[1] || "/";
  return pathname === "/" ? "/" : pathname;
}

export function contextualizeApiPath(
  path: string,
  context: RuntimeUiContext,
  _method = "GET",
): string {
  if (context.kind !== "project") return path;

  const url = new URL(path, "http://ratel.local");
  if (!url.pathname.startsWith("/api/") || CONTEXT_FREE_API_PATHS.has(url.pathname)) return path;

  url.searchParams.set("projectId", context.projectId);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function scopeTarget(
  context: RuntimeUiContext,
  scope: "user" | "project" | "local",
): MutationScopeTarget {
  if (scope === "user") return { scope: "user" };
  if (context.kind !== "project") {
    throw new Error(`${scope} scope requires a project context`);
  }
  return { scope, projectId: context.projectId };
}

export function legacyGlobalPath(pathname: string): string | null {
  if (pathname === "/") return "/global";
  if (LEGACY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return `/global${pathname}`;
  }
  return null;
}

export function safeRememberedRoute(value: string | null): string | null {
  if (!value || value.includes("\\") || value.includes("?") || value.includes("#")) return null;
  if (value === "/all" || value === "/global" || value.startsWith("/global/")) return value;
  if (/^\/projects\/[^/]+(?:\/.*)?$/.test(value)) return value;
  return null;
}

function safelyDecodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
