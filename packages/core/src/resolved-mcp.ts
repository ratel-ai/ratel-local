import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { RatelScopeRef } from "./context.js";
import type { RatelConfig, ServerEntry } from "./lib/config.js";
import { expandEnvPlaceholders } from "./lib/env-placeholders.js";

export interface McpConfigDocument {
  ref: RatelScopeRef;
  config: RatelConfig;
}

export interface OAuthStoreKey {
  path: string;
  fingerprint: string;
}

export interface ResolvedMcpEntry {
  name: string;
  entry: ServerEntry;
  owner: RatelScopeRef;
  status: "effective" | "shadowed" | "invalid";
  shadowedBy?: RatelScopeRef;
  runtimeCwd: string;
  oauthKey: OAuthStoreKey;
  diagnostics: Array<{ code: string; message: string }>;
}

export interface ResolveMcpEntriesInput {
  homeDir: string;
  projectRoot?: string;
  documents: McpConfigDocument[];
  pathExists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

export function resolveMcpEntries(input: ResolveMcpEntriesInput): ResolvedMcpEntry[] {
  const candidates: ResolvedMcpEntry[] = [];
  for (const document of input.documents) {
    for (const [name, entry] of Object.entries(document.config.mcpServers)) {
      const diagnostics = validateRuntimeEntry(input, entry);
      candidates.push({
        name,
        entry,
        owner: document.ref,
        status: diagnostics.length === 0 ? "effective" : "invalid",
        runtimeCwd: runtimeCwd(input, entry),
        oauthKey: oauthStoreKey(input.homeDir, document.ref, name, entry, input.env),
        diagnostics,
      });
    }
  }

  const selectedByName = new Map<string, ResolvedMcpEntry>();
  for (const candidate of [...candidates].sort(comparePrecedence)) {
    if (candidate.status === "invalid") continue;
    const selected = selectedByName.get(candidate.name);
    if (selected) {
      candidate.status = "shadowed";
      candidate.shadowedBy = selected.owner;
    } else {
      selectedByName.set(candidate.name, candidate);
    }
  }

  return candidates.sort(
    (a, b) =>
      compareText(a.name, b.name) ||
      statusRank(a.status) - statusRank(b.status) ||
      scopeRank(b.owner) - scopeRank(a.owner),
  );
}

function validateRuntimeEntry(
  input: ResolveMcpEntriesInput,
  entry: ServerEntry,
): ResolvedMcpEntry["diagnostics"] {
  if (!entry.cwd || !isAbsolute(entry.cwd)) return [];
  const pathExists = input.pathExists ?? existsSync;
  if (pathExists(entry.cwd)) return [];
  return [
    {
      code: "mcp-cwd-missing",
      message: `configured absolute cwd does not exist: ${entry.cwd}`,
    },
  ];
}

function runtimeCwd(input: ResolveMcpEntriesInput, entry: ServerEntry): string {
  const base = input.projectRoot ?? input.homeDir;
  if (!entry.cwd) return base;
  return isAbsolute(entry.cwd) ? entry.cwd : resolve(base, entry.cwd);
}

function oauthStoreKey(
  homeDir: string,
  owner: RatelScopeRef,
  name: string,
  entry: ServerEntry,
  env: NodeJS.ProcessEnv = process.env,
): OAuthStoreKey {
  const ownerKey = owner.scope === "user" ? "user" : `${owner.projectId}\0${owner.scope}`;
  const key = createHash("sha256").update(ownerKey).update("\0").update(name).digest("base64url");
  const path =
    owner.scope === "user"
      ? join(homeDir, ".ratel", "oauth", "user", `${key}.json`)
      : join(homeDir, ".ratel", "oauth", "projects", owner.projectId, owner.scope, `${key}.json`);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        type: entry.type,
        url: effectiveUrl(entry.url, env),
        clientId: entry.clientId ?? null,
        scope: entry.scope ?? null,
      }),
    )
    .digest("base64url");
  return { path, fingerprint };
}

function effectiveUrl(url: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (url === undefined) return null;
  const expanded = expandEnvPlaceholders(url, env);
  try {
    return new URL(expanded).toString();
  } catch {
    // Invalid URLs are diagnosed by the transport. Keep the expanded value in
    // the fingerprint so an environment change still invalidates credentials.
    return expanded;
  }
}

function comparePrecedence(a: ResolvedMcpEntry, b: ResolvedMcpEntry): number {
  return scopeRank(b.owner) - scopeRank(a.owner) || compareText(a.name, b.name);
}

function scopeRank(ref: RatelScopeRef): number {
  if (ref.scope === "local") return 3;
  if (ref.scope === "project") return 2;
  return 1;
}

function statusRank(status: ResolvedMcpEntry["status"]): number {
  if (status === "effective") return 0;
  if (status === "invalid") return 1;
  return 2;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
