import { locateRatelBin, type ResolvedBin, whichRatelBin } from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "./handlers/types.js";

export interface ResolveCliRatelBinOptions {
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
}

export async function resolveCliRatelBin(
  ctx: HandlerCtx,
  opts: ResolveCliRatelBinOptions = {},
): Promise<ResolvedBin> {
  return locateRatelBin({
    envVar: opts.envVar ?? process.env.RATEL_MCP_BIN,
    whichResult: opts.whichResult ?? whichRatelBin(),
    workspaceRoot: opts.workspaceRoot,
    exists: opts.exists,
    promptForPath: async () => {
      const v = await ctx.prompts.text({ message: "Path to ratel-mcp binary?" });
      return ctx.prompts.isCancel(v) ? "" : (v as string);
    },
  });
}
