import type { JsonRequestInit } from "@/App";
import type { SkillSource } from "@/components/source-icon";

/** Agent harnesses Ratel can pull skills from (and link MCP gateways into). */
export type AgentHostKind = "claude-code" | "codex";

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Managed skills report their origin agent (or "ratel" when created here);
   *  available skills report the agent whose folder they live in. */
  source: SkillSource;
  /** Managed skills may be linked native folders, legacy managed copies, or Ratel-authored. */
  mode?: "linked" | "moved" | "ratel";
}

export interface SkillProblem {
  id: string;
  where: string;
  reason: string;
}

export interface SkillsResponse {
  managedDir: string;
  nativeDir: string;
  codexDir: string;
  managed: SkillSummary[];
  available: SkillSummary[];
  problems: SkillProblem[];
}

/** Load managed + available skills from the gateway. */
export function fetchSkills(
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>,
): Promise<SkillsResponse> {
  return request<SkillsResponse>("/api/skills");
}

/**
 * Map an Agent Setup host kind to the skill `source` used by `/api/skills`.
 * The agent pages speak in host kinds ("claude-code"), while skills are tagged
 * with the shorter agent source ("claude") — this is the one bit of glue.
 */
export function agentKindToSkillSource(kind: AgentHostKind): SkillSource {
  return kind === "codex" ? "codex" : "claude";
}

/** Skills from one agent that Ratel does not yet manage. */
export function availableSkillsForKind(
  available: readonly SkillSummary[],
  kind: AgentHostKind,
): SkillSummary[] {
  const source = agentKindToSkillSource(kind);
  return available.filter((skill) => skill.source === source);
}
