import type { JsonRequestInit } from "@/App";

export interface CoveredSkill {
  skillId: string;
  score: number;
}

export type IntentCoverage = { status: "covered"; skills: CoveredSkill[] } | { status: "gap" };

export interface IntentRecord {
  content: string;
  coverage: IntentCoverage;
  sessions: string[];
  firstSeen: string;
  lastSeen: string;
  /** Server-computed ranking score (frequency + recency). Higher = suggest first. */
  score?: number;
  /** Evidence spans/turns that support this intent — the "proof". */
  evidences?: string[];
}

export interface SessionSummary {
  sessionId: string;
  host?: string;
  cwd?: string;
  analyzedAt: string;
  intentCount: number;
  gapCount: number;
  /** New captured messages since this session was last analyzed. */
  newTurnCount?: number;
}

export interface Cadence {
  everyNMessages: number;
  onIdle: boolean;
}

export interface IntentsIndex {
  version: number;
  intents: IntentRecord[];
  sessions: SessionSummary[];
  cadence?: Cadence;
  /** Master switch: false means capture + analysis are turned off. */
  enabled?: boolean;
  /** True while a fire-and-forget analysis run is in progress on the server. */
  running?: boolean;
  /** The session a per-chat run is processing (null for batch runs); drives per-chat indicators. */
  runningSessionId?: string | null;
  /** Sessions queued behind the running one (chained per-chat analyses). */
  queuedSessionIds?: string[];
  /** Message from the last background run that failed, else null. */
  lastError?: string | null;
}

/** The run is fire-and-forget; the server returns immediately and the UI polls for `running`. */
export interface RunKickoff {
  started: boolean;
  alreadyRunning?: boolean;
  queued?: boolean;
  disabled?: boolean;
}

export type ChatSourceKind = "hooks" | "api" | "cloud";
export type ExtractorProvider = "http" | "naive" | "cloud";
export type SkillGenProvider = "auto" | "anthropic-api" | "claude-cli";

export interface AnalysisSettings {
  enabled?: boolean;
  chatSource?: ChatSourceKind;
  extractor?: {
    provider?: ExtractorProvider;
    endpoint?: string;
    apiKey?: string;
    model?: string;
  };
  cadence?: {
    auto?: boolean;
    everyNMessages?: number;
    onIdle?: boolean;
    recentHours?: number;
  };
  skillGen?: {
    provider?: SkillGenProvider;
    apiKey?: string;
    /** Model used to author skills; also sets the expected authoring time in the UI. */
    model?: string;
  };
  coverage?: {
    minScore?: number;
    relativeRatio?: number;
    maxSkills?: number;
  };
}

export interface AnalysisSettingsResponse {
  analysis: AnalysisSettings;
  /** Sentinel the server returns for stored secrets; echo it back to keep them. */
  secretMask: string;
}

export interface SkillDraft {
  name: string;
  description: string;
  tags?: string[];
  body: string;
}

/** Result of starting a background skill-authoring job. */
export interface OfferStart {
  started: boolean;
  alreadyRunning?: boolean;
  intent: string;
  model: string;
}

/** Polled status of a background skill-authoring job. */
export interface OfferStatus {
  status: "idle" | "running" | "done" | "error";
  draft?: SkillDraft;
  error?: string;
  model?: string;
  startedAt?: string;
}

/** One entry in the server's live offer-job registry (survives UI navigation). */
export interface OfferJobSummary {
  intent: string;
  status: "running" | "done" | "error";
  model: string;
  startedAt: string;
  error?: string;
  hasDraft: boolean;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  ts?: string;
}

export interface ChatSummary {
  sessionId: string;
  host: string;
  cwd?: string;
  title: string;
  turnCount: number;
  updatedAt?: string;
  lastAnalyzedAt?: string;
  idle: boolean;
  intentCount: number;
  gapCount: number;
  analyzed: boolean;
}

export interface ChatDetail {
  sessionId: string;
  host: string;
  cwd?: string;
  title: string;
  /** The loaded window of turns (the most recent `turns.length` of `total`). */
  turns: ChatTurn[];
  /** Total turns in the conversation, so the UI knows whether earlier ones can be loaded. */
  total: number;
}

export interface RunLogSessionEntry {
  sessionId: string;
  host?: string;
  ok: boolean;
  error?: string;
  intents: number;
  gaps: number;
  turns: number;
  latencyMs: number;
  cacheHit: boolean;
}

export interface RunLogEntry {
  runId: string;
  at: string;
  trigger: string;
  model?: string;
  durationMs: number;
  totalIntents: number;
  totalGaps: number;
  sessions: RunLogSessionEntry[];
}

export interface ObservabilitySummary {
  totalRuns: number;
  lastRunAt: string | null;
  avgDurationMs: number;
  avgGapsPerRun: number;
}

export interface ObservabilityResponse {
  runs: RunLogEntry[];
  summary: ObservabilitySummary;
}

type Request = <T>(path: string, init?: JsonRequestInit) => Promise<T>;

export function fetchIntents(request: Request): Promise<IntentsIndex> {
  return request<IntentsIndex>("/api/intents");
}

export function runIntents(request: Request, sessionId?: string): Promise<RunKickoff> {
  return request<RunKickoff>("/api/intents/run", {
    method: "POST",
    body: sessionId ? { sessionId } : {},
  });
}

/** Re-analyze every captured chat (ignores the new-activity/recency filters). */
export function runAllIntents(request: Request): Promise<RunKickoff> {
  return request<RunKickoff>("/api/intents/run", { method: "POST", body: { all: true } });
}

export function fetchAnalysisSettings(request: Request): Promise<AnalysisSettingsResponse> {
  return request<AnalysisSettingsResponse>("/api/analysis/settings");
}

export function saveAnalysisSettings(
  request: Request,
  analysis: AnalysisSettings,
): Promise<AnalysisSettingsResponse> {
  return request<AnalysisSettingsResponse>("/api/analysis/settings", {
    method: "PUT",
    body: { analysis },
  });
}

/** Starts a BACKGROUND authoring job; poll {@link offerSkillStatus} for the draft. */
export function offerSkill(request: Request, intent: string): Promise<OfferStart> {
  return request<OfferStart>("/api/skills/offer", {
    method: "POST",
    body: { intent },
  });
}

export function offerSkillStatus(request: Request, intent: string): Promise<OfferStatus> {
  return request<OfferStatus>(`/api/skills/offer/status?intent=${encodeURIComponent(intent)}`);
}

/** All in-flight/finished authoring jobs, so a returning user can still reach a result. */
export function listOfferJobs(request: Request): Promise<{ jobs: OfferJobSummary[] }> {
  return request<{ jobs: OfferJobSummary[] }>("/api/skills/offer/jobs");
}

/** Drop a finished/declined authoring job so it stops surfacing as "Skill ready". */
export function clearOfferJob(request: Request, intent: string): Promise<{ cleared: boolean }> {
  return request<{ cleared: boolean }>(`/api/skills/offer?intent=${encodeURIComponent(intent)}`, {
    method: "DELETE",
  });
}

export function fetchObservability(request: Request): Promise<ObservabilityResponse> {
  return request<ObservabilityResponse>("/api/intents/observability");
}

export function fetchChats(request: Request): Promise<{ chats: ChatSummary[] }> {
  return request<{ chats: ChatSummary[] }>("/api/chats");
}

/** Load a chat's most recent `limit` turns (plus `total`, so the UI can offer "load earlier"). */
export function fetchChat(
  request: Request,
  sessionId: string,
  limit?: number,
): Promise<ChatDetail> {
  const q = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return request<ChatDetail>(`/api/chats/${encodeURIComponent(sessionId)}${q}`);
}

export function deleteChat(request: Request, sessionId: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/api/chats/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

/**
 * Expected skill-generation duration (ms) for a model, used to pace the progress
 * animation. Matched by substring on the lowercased model name.
 */
export function estimateGenMs(model?: string): number {
  const m = (model ?? "").toLowerCase();
  if (m.includes("haiku")) return 12000;
  if (m.includes("opus")) return 55000;
  if (m.includes("sonnet")) return 30000;
  return 30000;
}

export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Preconfigured skill-generation model choices for the Settings dropdown. CLI
 * uses `claude --model` aliases; the API uses full model ids. `""` = the
 * provider's built-in default.
 */
export function skillGenModelOptions(provider: SkillGenProvider): ModelOption[] {
  const base: ModelOption[] = [{ value: "", label: "Default (recommended)" }];
  if (provider === "claude-cli") {
    return [
      ...base,
      { value: "haiku", label: "Haiku — fastest" },
      { value: "sonnet", label: "Sonnet — balanced" },
      { value: "opus", label: "Opus — most capable" },
    ];
  }
  return [
    ...base,
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5 — fastest" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
    { value: "claude-opus-4-8", label: "Opus 4.8 — most capable" },
  ];
}

export function deleteIntent(request: Request, content: string): Promise<unknown> {
  return request("/api/intents/delete", { method: "POST", body: { content } });
}

export function clearIntents(request: Request): Promise<unknown> {
  return request("/api/intents/clear", { method: "POST", body: {} });
}

/** Short, human label for a coverage verdict. */
export function coverageLabel(coverage: IntentCoverage): string {
  return coverage.status === "covered"
    ? `Covered by ${coverage.skills.map((s) => s.skillId).join(", ")}`
    : "No matching skill";
}
