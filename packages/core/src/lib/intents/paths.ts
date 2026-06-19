import { join } from "node:path";

export interface IntentsPaths {
  /** The `.ratel` home directory. */
  ratelDir: string;
  /** Where the capture hook writes chat turns + state. */
  chatDir: string;
  /** Where the runner writes the cumulative index + per-session results. */
  intentsDir: string;
}

/** Derive the chat + intents directories from a resolved `.ratel` home. */
export function intentsPaths(ratelDir: string): IntentsPaths {
  return {
    ratelDir,
    chatDir: join(ratelDir, "chat"),
    intentsDir: join(ratelDir, "intents"),
  };
}

/**
 * Resolve the `.ratel` home directory, honoring `RATEL_HOME` exactly as the
 * capture hook (`log-tool-usage.mjs` / `capture-chat.mjs`) does so the runner
 * reads from the same place the hooks write.
 */
export function resolveRatelDir(env: { RATEL_HOME?: string }, homeDir: string): string {
  return env.RATEL_HOME || join(homeDir, ".ratel");
}
