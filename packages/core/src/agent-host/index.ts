import { isRatelGatewayEntry } from "../gateway-entry.js";
import type { HierarchyEnv } from "../hierarchy.js";
import type { FileChange } from "../import-plan.js";
import type { JsonFs } from "../io.js";
import type { ServerEntry } from "../lib/index.js";
import type { ResolvedBin } from "../locate-bin.js";

export type AgentScope = "user" | "project" | "local";

export interface AgentHostAdapter {
  detect(ctx: AgentHostContext): Promise<AgentHostDetection>;
  read(ctx: AgentHostContext): Promise<AgentHostState>;
  planChanges(input: AgentHostPlanInput): Promise<AgentHostChangeSet>;
}

export interface AgentHostContext {
  env: HierarchyEnv;
  fs: JsonFs;
}

export interface AgentHostDetection {
  displayName: string;
  present: boolean;
  reasons: string[];
  warnings: string[];
}

export interface AgentHostState {
  host: DetectedAgentHost;
  scopes: AgentScopeState[];
}

export interface DetectedAgentHost {
  kind: string;
  displayName: string;
}

export interface AgentScopeState {
  scope: AgentScope;
  displayName: string;
  path: string;
  available: boolean;
  mcpServers: Record<string, ServerEntry>;
  raw?: Record<string, unknown>;
  rawText?: string;
}

export interface AgentHostPlanInput {
  state: AgentHostState;
  bin: ResolvedBin;
  ratelConfigPaths: RatelConfigPaths;
  installGatewayScopes?: Set<AgentScope>;
  removeEntriesByScope: Map<AgentScope, Set<string>>;
}

export interface RatelConfigPaths {
  user: string;
  project?: string;
  local?: string;
}

export interface AgentHostChangeSet {
  changes: FileChange[];
  summary: AgentHostChangeSummary;
}

export interface AgentHostChangeSummary {
  host: DetectedAgentHost;
  installedGatewayScopes: AgentScope[];
  removedNativeEntries: AgentHostRemovedEntry[];
  warnings: string[];
}

export interface AgentHostRemovedEntry {
  scope: AgentScope;
  name: string;
}

export type SupportedAgentHostKind = "claude-code" | "codex";

export interface SupportedAgentHost {
  kind: SupportedAgentHostKind;
  displayName: string;
}

export const SUPPORTED_AGENT_HOSTS: readonly SupportedAgentHost[] = [
  { kind: "claude-code", displayName: "Claude Code" },
  { kind: "codex", displayName: "Codex" },
];

export function isSupportedAgentHostKind(value: unknown): value is SupportedAgentHostKind {
  return value === "claude-code" || value === "codex";
}

export async function createSupportedAgentHostAdapter(
  kind: SupportedAgentHostKind,
): Promise<AgentHostAdapter> {
  switch (kind) {
    case "claude-code": {
      const { ClaudeCodeAgentHostAdapter } = await import("./claude-code.js");
      return new ClaudeCodeAgentHostAdapter();
    }
    case "codex": {
      const { CodexAgentHostAdapter } = await import("./codex.js");
      return new CodexAgentHostAdapter();
    }
  }
}

export class NamedAgentHostAdapter implements AgentHostAdapter {
  private adapter: AgentHostAdapter | null = null;

  constructor(readonly kind: SupportedAgentHostKind) {}

  async detect(ctx: AgentHostContext): Promise<AgentHostDetection> {
    return (await this.ensureAdapter()).detect(ctx);
  }

  async read(ctx: AgentHostContext): Promise<AgentHostState> {
    return (await this.ensureAdapter()).read(ctx);
  }

  async planChanges(input: AgentHostPlanInput): Promise<AgentHostChangeSet> {
    return (await this.ensureAdapter()).planChanges(input);
  }

  private async ensureAdapter(): Promise<AgentHostAdapter> {
    this.adapter ??= await createSupportedAgentHostAdapter(this.kind);
    return this.adapter;
  }
}

export class AutomaticAgentHostAdapter implements AgentHostAdapter {
  private selected: AgentHostAdapter | null = null;

  constructor(private readonly adapters?: AgentHostAdapter[]) {}

  async detect(ctx: AgentHostContext): Promise<AgentHostDetection> {
    const warnings: string[] = [];
    let firstPresent: { adapter: AgentHostAdapter; detection: AgentHostDetection } | null = null;
    for (const adapter of await this.resolveAdapters()) {
      const detection = await adapter.detect(ctx);
      warnings.push(...detection.warnings);
      if (detection.present) {
        firstPresent ??= { adapter, detection };
        const state = await adapter.read(ctx);
        if (hasNativeMcpEntries(state)) {
          this.selected = adapter;
          return { ...detection, warnings };
        }
      }
    }
    if (firstPresent) {
      this.selected = firstPresent.adapter;
      return { ...firstPresent.detection, warnings };
    }
    return {
      displayName: "Automatic",
      present: false,
      reasons: ["No supported agent host config found."],
      warnings,
    };
  }

  async read(ctx: AgentHostContext): Promise<AgentHostState> {
    const adapter = await this.ensureSelected(ctx);
    return adapter.read(ctx);
  }

  async planChanges(input: AgentHostPlanInput): Promise<AgentHostChangeSet> {
    const adapter = this.selected;
    if (!adapter) throw new Error("Automatic agent host has not selected an adapter.");
    return adapter.planChanges(input);
  }

  private async ensureSelected(ctx: AgentHostContext): Promise<AgentHostAdapter> {
    if (this.selected) return this.selected;
    const detection = await this.detect(ctx);
    if (!detection.present || !this.selected) {
      throw new Error("No supported agent host config found.");
    }
    return this.selected;
  }

  private async resolveAdapters(): Promise<AgentHostAdapter[]> {
    if (this.adapters) return this.adapters;
    return Promise.all(
      SUPPORTED_AGENT_HOSTS.map((host) => createSupportedAgentHostAdapter(host.kind)),
    );
  }
}

function hasNativeMcpEntries(state: AgentHostState): boolean {
  return state.scopes.some((scope) =>
    Object.entries(scope.mcpServers).some(([name, entry]) => !isRatelGatewayEntry(name, entry)),
  );
}
