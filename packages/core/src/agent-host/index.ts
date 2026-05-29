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
  link(input: GatewayLinkInput): Promise<AgentHostChangeSet>;
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

export interface GatewayLinkInput {
  state: AgentHostState;
  bin: ResolvedBin;
  ratelConfigPaths: RatelConfigPaths;
  replacedEntriesByScope: Map<AgentScope, Set<string>>;
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

  async link(input: GatewayLinkInput): Promise<AgentHostChangeSet> {
    const adapter = this.selected;
    if (!adapter) throw new Error("Automatic agent host has not selected an adapter.");
    return adapter.link(input);
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
    const [{ ClaudeCodeAgentHostAdapter }, { CodexAgentHostAdapter }] = await Promise.all([
      import("./claude-code.js"),
      import("./codex.js"),
    ]);
    return [new ClaudeCodeAgentHostAdapter(), new CodexAgentHostAdapter()];
  }
}

function hasNativeMcpEntries(state: AgentHostState): boolean {
  return state.scopes.some((scope) =>
    Object.entries(scope.mcpServers).some(([name, entry]) => !isRatelGatewayEntry(name, entry)),
  );
}
