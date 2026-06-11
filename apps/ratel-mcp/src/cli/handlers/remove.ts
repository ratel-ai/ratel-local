import {
  type BackupManifest,
  type RatelScope,
  removeServerEntry,
  resolveScope,
} from "@ratel-ai/mcp-core";
import type { HandlerCtx } from "./types.js";

export async function runRemove(ctx: HandlerCtx): Promise<BackupManifest> {
  const scope = readScope(ctx);
  const name = readRequiredString(ctx, "name");
  const result = await removeServerEntry(ctx, { scope, name });
  ctx.log(`removed "${name}" from ${result.path}`);
  return result.manifest;
}

function readScope(ctx: HandlerCtx): RatelScope {
  return resolveScope(ctx.argv.flags.scope);
}

function readRequiredString(ctx: HandlerCtx, key: string): string {
  const v = ctx.argv.flags[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`--${key} is required`);
  }
  return v;
}
