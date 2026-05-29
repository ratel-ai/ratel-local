import type { BackupFs, HierarchyEnv, JsonFs } from "@ratel-ai/mcp-core";
import type { ParsedArgs } from "../args.js";
import type { PromptAdapter } from "../prompts.js";

export interface HandlerCtx {
  argv: ParsedArgs;
  env: HierarchyEnv;
  fs: JsonFs & BackupFs;
  log: (message: string) => void;
  prompts: PromptAdapter;
}
