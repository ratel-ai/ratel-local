import { realpath } from "node:fs/promises";
import {
  type AuthFlowOptions,
  type AuthFlowResult,
  buildGatewayFromConfig,
  type McpConfigDocument,
  markDenseAuthReconnectRequired,
  mergeConfigs,
  parseConfig,
  projectIdFromCanonicalRoot,
  type ResolvedMcpEntry,
  ratelConfigPath,
  readJson,
  resolveMcpEntries,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "./types.js";

export type AuthRunner = (opts: AuthFlowOptions) => Promise<AuthFlowResult[]>;

export interface RunMcpAuthOptions {
  /** Override the orchestrator. Tests stub this to avoid spinning up a live gateway. */
  authRunner?: AuthRunner;
}

export async function runMcpAuth(ctx: HandlerCtx, opts: RunMcpAuthOptions = {}): Promise<void> {
  const resolved = await loadResolvedContext(ctx);
  const entries = resolved.entries.filter(({ status }) => status === "effective");
  if (entries.length === 0) {
    ctx.log("[ratel] no Ratel config found in user/project/local scope; nothing to auth");
    return;
  }

  if (ctx.argv.flags.check === true) {
    await printCheckReport(ctx, entries);
    return;
  }

  const positional = ctx.argv.rest[0];
  if (positional && !entries.some(({ name }) => name === positional)) {
    throw new Error(`unknown upstream "${positional}" — not present in the effective context`);
  }
  const authOptions: AuthFlowOptions = positional ? { name: positional } : {};
  let results: AuthFlowResult[];
  if (opts.authRunner) {
    results = await opts.authRunner(authOptions);
  } else {
    const gateway = await buildGatewayFromConfig(
      { mcpServers: {} },
      { logger: ctx.log, resolvedMcpEntries: entries },
    );
    try {
      results = await gateway.runAuthFlow(authOptions);
    } finally {
      await gateway.close();
    }
  }
  if (resolved.denseRetrieval) {
    results = markDenseAuthReconnectRequired(results);
  }
  printResults(ctx, results);
}

function printResults(ctx: HandlerCtx, results: AuthFlowResult[]): void {
  if (results.length === 0) {
    ctx.log("[ratel] no upstreams to authorize");
    return;
  }
  for (const r of results) {
    const annotation =
      r.status === "authorized" && r.mode
        ? ` (${r.mode === "refresh" ? "refreshed" : "re-authed"})`
        : "";
    const tail = r.reason ? `: ${r.reason}` : "";
    ctx.log(`  ${r.name.padEnd(20)} ${r.status}${annotation}${tail}`);
  }
}

interface StoredOAuth {
  tokens?: { access_token?: string; refresh_token?: string };
  expires_at?: number;
  unsupported?: { reason?: string; detected_at?: string };
  resource_fingerprint?: string;
}

type CheckStatus = "n/a" | "needs auth" | "expired" | "ok" | "unsupported";

async function printCheckReport(ctx: HandlerCtx, entries: ResolvedMcpEntry[]): Promise<void> {
  const lines: string[] = [];
  for (const resolved of entries) {
    const { status, detail } = await checkUpstream(ctx, resolved);
    const detailText = detail ? `  ${detail}` : "";
    lines.push(`  ${resolved.name.padEnd(20)} [${status}]${detailText}`);
  }
  ctx.log(lines.join("\n"));
}

async function checkUpstream(
  ctx: HandlerCtx,
  resolved: ResolvedMcpEntry,
): Promise<{ status: CheckStatus; detail?: string }> {
  const { entry } = resolved;
  if (entry.type !== "http" && entry.type !== "sse") return { status: "n/a" };
  if (!ctx.env.homeDir) return { status: "needs auth" };
  const stored = await readJson<StoredOAuth>(ctx.fs, resolved.oauthKey.path);
  if (
    stored?.resource_fingerprint &&
    stored.resource_fingerprint !== resolved.oauthKey.fingerprint
  ) {
    return { status: "needs auth", detail: "stored credentials belong to another resource" };
  }
  if (!stored?.tokens?.access_token) {
    if (stored?.unsupported?.reason) {
      return { status: "unsupported", detail: stored.unsupported.reason };
    }
    return { status: "needs auth", detail: "no tokens stored" };
  }
  const expiresAt = typeof stored.expires_at === "number" ? stored.expires_at : undefined;
  const refreshAvailable = typeof stored.tokens.refresh_token === "string";
  const now = Date.now();
  if (expiresAt !== undefined && expiresAt < now) {
    const ago = humanizeDuration(now - expiresAt);
    const refreshNote = refreshAvailable ? ", refresh available" : ", no refresh token";
    return { status: "expired", detail: `expired ${ago} ago${refreshNote}` };
  }
  if (expiresAt !== undefined) {
    return { status: "ok", detail: `expires in ${humanizeDuration(expiresAt - now)}` };
  }
  return { status: "ok" };
}

async function loadResolvedContext(
  ctx: HandlerCtx,
): Promise<{ entries: ResolvedMcpEntry[]; denseRetrieval: boolean }> {
  const projectRoot = ctx.env.projectRoot
    ? await realpath(ctx.env.projectRoot).catch(() => ctx.env.projectRoot)
    : undefined;
  const projectId = projectRoot ? projectIdFromCanonicalRoot(projectRoot) : undefined;
  const documents: McpConfigDocument[] = [];
  for (const scope of ["user", "project", "local"] as const) {
    if (scope !== "user" && (!projectRoot || !projectId)) continue;
    const path = ratelConfigPath(scope, { homeDir: ctx.env.homeDir, projectRoot });
    const document = await readJson(ctx.fs, path);
    if (!document) continue;
    if (scope === "user") {
      documents.push({ ref: { scope: "user" }, config: parseConfig(document) });
    } else if (projectId) {
      documents.push({ ref: { scope, projectId }, config: parseConfig(document) });
    }
  }
  const retrieval = mergeConfigs(documents.map(({ config }) => config)).retrieval;
  return {
    entries: resolveMcpEntries({
      homeDir: ctx.env.homeDir,
      ...(projectRoot ? { projectRoot } : {}),
      documents,
    }),
    denseRetrieval: retrieval?.method === "semantic" || retrieval?.method === "hybrid",
  };
}

function humanizeDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}
