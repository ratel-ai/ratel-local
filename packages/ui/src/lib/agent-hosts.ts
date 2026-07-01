import type { AgentHostKind } from "@/lib/skills";

export type { AgentHostKind };

/**
 * Shared agent-host domain: the detection summary returned by `/api/agent-hosts`
 * plus the small helpers that read it. Consolidated here so `AppShell`, the agent
 * setup pages, and the onboarding flow all speak the same types instead of keeping
 * private copies.
 */

export type AgentScope = "user" | "project" | "local";
export type AgentPosture = "unavailable" | "empty" | "not-linked" | "ratel-only" | "mixed";

export interface AgentHostDetection {
  displayName: string;
  present: boolean;
  reasons: string[];
  warnings: string[];
}

export interface AgentScopePosture {
  scope: AgentScope;
  displayName: string;
  path: string;
  available: boolean;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames?: string[];
  ratelEntryNames?: string[];
}

export interface ClaudeStatuslineState {
  settingsPath: string;
  status: "not-installed" | "installed" | "other";
  installed: boolean;
  ownedByRatel: boolean;
  command: string | null;
  ratelEnabled: boolean;
  ratelEnabledSources: string[];
  warnings: string[];
}

export interface DetectedAgentHostSummary {
  kind: AgentHostKind;
  displayName: string;
  detection: AgentHostDetection;
  posture: AgentPosture;
  nativeEntryCount: number;
  ratelEntryCount: number;
  entryCount: number;
  nativeEntryNames?: string[];
  ratelEntryNames?: string[];
  missingRatelEntryNames?: string[];
  scopes: AgentScopePosture[];
  statusline?: ClaudeStatuslineState;
}

export interface AgentHostsResponse {
  hosts: DetectedAgentHostSummary[];
}

export function agentHostsFromResponse(body: unknown): DetectedAgentHostSummary[] {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as AgentHostsResponse).hosts)
  ) {
    return (body as AgentHostsResponse).hosts;
  }
  return [];
}

export function preferredHostKind(hosts: readonly DetectedAgentHostSummary[]): AgentHostKind {
  return hosts.find((host) => host.detection.present)?.kind ?? hosts[0]?.kind ?? "claude-code";
}

export function missingRatelEntryNames(host: DetectedAgentHostSummary): string[] {
  return host.missingRatelEntryNames ?? [];
}
