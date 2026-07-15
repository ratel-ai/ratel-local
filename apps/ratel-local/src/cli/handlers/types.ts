import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/ratel-local-core";
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
  stdin?: () => Promise<string>;
  stdout?: (message: string) => void;
}
