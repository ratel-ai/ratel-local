import { join } from "node:path";
import type { JsonFs } from "../../io.js";
import type { RunLogEntry } from "./types.js";

/** Keep the runs log bounded so it stays cheap to read and write. */
const MAX_RUN_LOG_ENTRIES = 200;

/** Default number of entries returned by {@link readRunLog}. */
const DEFAULT_READ_LIMIT = 50;

/** Path to the append-only run telemetry log: `<intentsDir>/runs.jsonl`. */
export function runsLogPath(intentsDir: string): string {
  return join(intentsDir, "runs.jsonl");
}

/** Split file contents into non-empty, trimmed JSONL lines. */
function toLines(contents: string | null): string[] {
  if (!contents) return [];
  return contents.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Append one run entry to the JSONL log, keeping only the most recent
 * {@link MAX_RUN_LOG_ENTRIES} entries. Malformed pre-existing lines are kept
 * verbatim (we only trim the count); the write is atomic.
 */
export async function appendRunLog(
  fs: JsonFs,
  intentsDir: string,
  entry: RunLogEntry,
): Promise<void> {
  const existing = toLines(await fs.read(runsLogPath(intentsDir)));
  const next = [...existing, JSON.stringify(entry)].slice(-MAX_RUN_LOG_ENTRIES);
  await fs.writeAtomic(runsLogPath(intentsDir), `${next.join("\n")}\n`);
}

/**
 * Read run entries newest-first, capped to `limit` (default
 * {@link DEFAULT_READ_LIMIT}). Malformed lines are skipped rather than thrown.
 */
export async function readRunLog(
  fs: JsonFs,
  intentsDir: string,
  limit = DEFAULT_READ_LIMIT,
): Promise<RunLogEntry[]> {
  const lines = toLines(await fs.read(runsLogPath(intentsDir)));
  const entries: RunLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as RunLogEntry);
    } catch {
      // skip malformed line
    }
  }
  return entries.reverse().slice(0, limit);
}
