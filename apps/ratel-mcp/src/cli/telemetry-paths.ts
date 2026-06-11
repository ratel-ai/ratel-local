import { homedir } from "node:os";
import { join } from "node:path";

/** Telemetry root. Per-project buckets nest under this. */
export function defaultTelemetryDir(): string {
  return process.env.RATEL_TELEMETRY_DIR ?? join(homedir(), ".ratel", "telemetry");
}

/** Mirror of Claude Code's `~/.claude/projects/<slug>/` rule: every `/` and `.` becomes `-`. */
export function slugifyProjectPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

export function projectBucketDir(root: string, absPath: string): string {
  return join(root, slugifyProjectPath(absPath));
}
