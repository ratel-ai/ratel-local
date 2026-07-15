import type { JsonRequestInit } from "@/App";
import type { SkillSource } from "@/components/source-icon";
import type { RuntimeUiContext } from "@/lib/runtime-context";

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
  candidateId?: string;
  registration?: SkillRegistrationSummary;
}

export interface SkillScopeRef {
  scope: "user" | "project" | "local";
  projectId?: string;
}

export interface SkillRegistrationSummary {
  ref: {
    scopeRef: SkillScopeRef;
    id: string;
    kind: "entry" | "legacy";
    configuredPath: string;
  };
  scopeRef: SkillScopeRef;
  mode: "reference" | "copy";
  state: "effective" | "shadowed" | "duplicate" | "invalid";
  editable: boolean;
}

export interface SkillRegistrationDiagnostic {
  code: string;
  message: string;
  severity?: "warning" | "error";
}

export interface SkillRegistrationView extends SkillRegistrationSummary {
  id: string;
  source: string;
  configuredPath?: string;
  canonicalPath?: string;
  diagnostics?: SkillRegistrationDiagnostic[];
}

export interface SkillRegistrationGroup {
  scope: SkillScopeRef["scope"];
  registrations: SkillRegistrationView[];
}

export type SkillImportMode = "reference" | "copy";
export type SkillImportScope = SkillScopeRef["scope"];

export interface SkillImportTargetChoice {
  scope: SkillImportScope;
  mode: SkillImportMode;
}

export interface SkillImportSelection {
  candidateId: string;
  targets: Array<{ scopeRef: SkillScopeRef; mode: SkillImportMode }>;
}

export type SkillImportRequest = <T>(path: string, init?: JsonRequestInit) => Promise<T>;

interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

interface DiscoveredSkill {
  candidateId: string;
  id: string;
  source: string;
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
  effectiveSkills?: ResolvedSkill[];
  registrations?: SkillRegistrationView[];
  discovered?: DiscoveredSkill[];
  diagnostics?: Array<{ code: string; message: string }>;
}

/** Preserve the resolver's configured view, including non-effective entries. */
export function configuredSkillRegistrationGroups(
  response: SkillsResponse,
  context: RuntimeUiContext,
): SkillRegistrationGroup[] {
  const scopes: SkillScopeRef["scope"][] =
    context.kind === "project"
      ? ["user", "project", "local"]
      : context.kind === "global"
        ? ["user"]
        : [];
  return scopes.map((scope) => ({
    scope,
    registrations: (response.registrations ?? [])
      .filter(
        (registration) =>
          registration.scopeRef.scope === scope &&
          (scope === "user" ||
            (context.kind === "project" && registration.scopeRef.projectId === context.projectId)),
      )
      .sort(
        (a, b) =>
          a.id.localeCompare(b.id) ||
          (a.configuredPath ?? "").localeCompare(b.configuredPath ?? ""),
      ),
  }));
}

export function availableSkillImportScopes(context: RuntimeUiContext): SkillImportScope[] {
  if (context.kind === "global") return ["user"];
  if (context.kind === "project") return ["user", "project", "local"];
  return [];
}

export function defaultSkillImportTarget(
  context: RuntimeUiContext,
): SkillImportTargetChoice | null {
  if (context.kind === "global") return { scope: "user", mode: "reference" };
  if (context.kind === "project") return { scope: "project", mode: "reference" };
  return null;
}

export function buildSkillImportSelections(
  skills: readonly SkillSummary[],
  context: RuntimeUiContext,
  target: SkillImportTargetChoice,
): SkillImportSelection[] {
  if (!availableSkillImportScopes(context).includes(target.scope)) {
    throw new Error(`${target.scope} scope is not available in the selected context`);
  }
  const scopeRef: SkillScopeRef =
    target.scope === "user"
      ? { scope: "user" }
      : context.kind === "project"
        ? { scope: target.scope, projectId: context.projectId }
        : (() => {
            throw new Error(`${target.scope} scope requires a project context`);
          })();
  return skills.map((skill) => {
    if (!skill.candidateId) throw new Error(`skill ${skill.id} is missing its candidateId`);
    return {
      candidateId: skill.candidateId,
      targets: [{ scopeRef, mode: target.mode }],
    };
  });
}

export async function applySkillImportSelections(
  request: SkillImportRequest,
  selections: readonly SkillImportSelection[],
): Promise<unknown> {
  const plan = await request<{ digest: string } & Record<string, unknown>>(
    "/api/skills/import/preview",
    { method: "POST", body: { selections } },
  );
  return request("/api/skills/import/apply", {
    method: "POST",
    body: { plan, digest: plan.digest },
  });
}

export function effectiveSkillSummaries(response: SkillsResponse): SkillSummary[] {
  if (!response.effectiveSkills) return response.managed ?? [];
  const effectiveRegistrations = new Map(
    (response.registrations ?? [])
      .filter(({ state }) => state === "effective")
      .map((registration) => [registration.id, registration]),
  );
  return response.effectiveSkills.map((skill) => {
    const registration = effectiveRegistrations.get(skill.id);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
      source: normalizedSource(registration?.source),
      ...(registration ? { registration } : {}),
    };
  });
}

export function discoveredSkillSummaries(response: SkillsResponse): SkillSummary[] {
  if (!response.discovered) return response.available ?? [];
  const configured = new Set(
    (response.registrations ?? [])
      .filter(({ state }) => state !== "invalid")
      .map(({ id, source }) => `${normalizedSource(source)}\0${id}`),
  );
  return response.discovered
    .filter(({ id, source }) => !configured.has(`${normalizedSource(source)}\0${id}`))
    .map((skill) => ({
      id: skill.id,
      name: skill.id,
      description: "Discovered native skill",
      tags: [],
      source: normalizedSource(skill.source),
      candidateId: skill.candidateId,
    }));
}

function normalizedSource(source: string | undefined): SkillSource {
  if (source === "claude") return "claude";
  if (source === "codex" || source === "codex-current" || source === "codex-legacy") {
    return "codex";
  }
  return "ratel";
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
