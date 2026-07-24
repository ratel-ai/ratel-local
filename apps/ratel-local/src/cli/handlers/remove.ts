import {
  type BackupManifest,
  type RatelScope,
  removeServerEntry,
  resolveScope,
} from "@ratel-ai/ratel-local-core";
import type { CliServerMutator, HandlerCtx } from "./types.js";

export async function runRemove(
  ctx: HandlerCtx,
  options: { mutateServer?: CliServerMutator } = {},
): Promise<BackupManifest | undefined> {
  const scope = readScope(ctx);
  const name = readRequiredString(ctx, "name");
  if (options.mutateServer) {
    const result = await options.mutateServer({ action: "remove", scope, name });
    ctx.log(`removed "${name}" from ${result.path}`);
    return undefined;
  }
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
