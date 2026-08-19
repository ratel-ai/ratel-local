import { realpath } from "node:fs/promises";
import type { OAuthStoreKey, RatelConfig, ServerEntry } from "@ratel-ai/ratel-local-core";
import {
  ProjectRootNotFoundError,
  parseConfig,
  projectIdFromCanonicalRoot,
  type RatelScope,
  ratelConfigPath,
  readJson,
  resolveMcpEntries,
} from "@ratel-ai/ratel-local-core";
import type { HandlerCtx } from "./types.js";

const SCOPES: readonly RatelScope[] = ["user", "project", "local"];

type AuthStatus = "n/a" | "needs auth" | "expired" | "ok" | "unsupported";

interface StoredOAuth {
  tokens?: { access_token?: string };
  expires_at?: number;
  unsupported?: { reason?: string; detected_at?: string };
  resource_fingerprint?: string;
}

export async function runMcpList(ctx: HandlerCtx): Promise<void> {
  let totalEntries = 0;
  const sections: string[] = [];
  const projectRoot = ctx.env.projectRoot
    ? await realpath(ctx.env.projectRoot).catch(() => ctx.env.projectRoot)
    : undefined;
  const env = { ...ctx.env, ...(projectRoot ? { projectRoot } : {}) };
  const projectId = projectRoot ? projectIdFromCanonicalRoot(projectRoot) : undefined;

  for (const scope of SCOPES) {
    let path: string;
    try {
      path = ratelConfigPath(scope, env);
    } catch (err) {
      if (err instanceof ProjectRootNotFoundError) continue;
      throw err;
    }
    const document = await readJson<RatelConfig>(ctx.fs, path);
    if (!document) continue;
    const cfg = parseConfig(document);
    const entries = Object.entries(cfg.mcpServers);
    if (entries.length === 0) continue;
    const ref =
      scope === "user"
        ? ({ scope: "user" } as const)
        : projectId
          ? ({ scope, projectId } as const)
          : undefined;
    if (!ref) continue;
    const resolvedEntries = resolveMcpEntries({
      homeDir: env.homeDir,
      ...(projectRoot ? { projectRoot } : {}),
      documents: [{ ref, config: cfg }],
    });

    totalEntries += entries.length;
    const lines = [`${scope}:  (${path})`];
    for (const [name, entry] of entries) {
      const resolved = resolvedEntries.find((candidate) => candidate.name === name);
      const status = await resolveAuthStatus(ctx, entry, resolved?.oauthKey);
      lines.push(`  ${name.padEnd(20)} [${status}]  ${formatEntry(entry)}`);
    }
    sections.push(lines.join("\n"));
  }

  if (totalEntries === 0) {
    ctx.log("no MCP servers configured in any Ratel scope");
    return;
  }
  ctx.log(sections.join("\n\n"));
}

function formatEntry(entry: ServerEntry): string {
  const type = entry.type ?? "stdio";
  if (type === "stdio") {
    const args = entry.args && entry.args.length > 0 ? ` ${entry.args.join(" ")}` : "";
    return `[${type}] ${entry.command ?? "<no command>"}${args}`;
  }
  return `[${type}] ${entry.url ?? "<no url>"}`;
}

async function resolveAuthStatus(
  ctx: HandlerCtx,
  entry: ServerEntry,
  oauthKey: OAuthStoreKey | undefined,
): Promise<AuthStatus> {
  if (entry.type !== "http" && entry.type !== "sse") return "n/a";
  if (!oauthKey) return "needs auth";
  const stored = await readJson<StoredOAuth>(ctx.fs, oauthKey.path);
  if (stored?.resource_fingerprint && stored.resource_fingerprint !== oauthKey.fingerprint) {
    return "needs auth";
  }
  if (!stored?.tokens?.access_token) {
    if (stored?.unsupported?.reason) return "unsupported";
    return "needs auth";
  }
  if (typeof stored.expires_at === "number" && stored.expires_at < Date.now()) {
    return "expired";
  }
  return "ok";
}
