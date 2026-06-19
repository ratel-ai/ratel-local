import { join } from "node:path";

export function defaultTelemetryDir(input: { homeDir: string; telemetryDir?: string }): string {
  return input.telemetryDir ?? join(input.homeDir, ".ratel", "telemetry");
}

/** Mirror Claude Code's project bucket rule: every `/` and `.` becomes `-`. */
export function slugifyProjectPath(absPath: string): string {
  return absPath.replace(/[/.]/g, "-");
}

export function projectBucketDir(root: string, absPath: string): string {
  return join(root, slugifyProjectPath(absPath));
}
