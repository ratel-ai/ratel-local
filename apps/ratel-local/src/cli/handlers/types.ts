import type {
  BackupFs,
  DocumentRevision,
  HierarchyEnv,
  JsonFs,
  PreparedChangeCoordinator,
  RatelScope,
  ServerEntry,
} from "@ratel-ai/ratel-local-core";
import type { AgentPluginInstaller } from "../../agent-plugin.js";
import type { ParsedArgs } from "../args.js";
import type { PromptAdapter } from "../prompts.js";

export interface HandlerCtx {
  argv: ParsedArgs;
  env: HierarchyEnv;
  fs: JsonFs & BackupFs;
  log: (message: string) => void;
  prompts: PromptAdapter;
  installAgentPlugin?: AgentPluginInstaller;
  preparedChanges?: PreparedChangeCoordinator;
  stdin?: () => Promise<string>;
  stdout?: (message: string) => void;
}

export interface CliServerMutationRequest {
  action: "add" | "edit" | "remove";
  scope: RatelScope;
  name: string;
  entry?: ServerEntry;
  expectedRevision?: DocumentRevision;
  force?: boolean;
}

export type CliServerMutator = (request: CliServerMutationRequest) => Promise<{ path: string }>;
