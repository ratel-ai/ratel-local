import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChatTurn, ExtractionResult, JsonFs } from "@ratel-ai/mcp-core";

/**
 * A content-addressed cache for {@link ExtractionResult}s, keyed by the turns +
 * model that produced them. Lets a run reuse a prior extraction instead of
 * re-invoking the (slow, costly) extractor when neither the conversation nor the
 * model has changed.
 */
export interface ExtractionCache {
  /** The cached result for `key`, or null on a miss / malformed entry. */
  get(key: string): Promise<ExtractionResult | null>;
  /** Store `value` under `key` (atomic write). */
  set(key: string, value: ExtractionResult): Promise<void>;
}

/**
 * Deterministic cache key for an extraction: the sha256 of the stable JSON of
 * `{ turns, model }`. Including the model id means switching models invalidates
 * the cache for the same conversation.
 */
export function cacheKey(turns: ChatTurn[], model?: string): string {
  const stable = JSON.stringify({
    turns: turns.map((t) => ({ role: t.role, content: t.content, ts: t.ts })),
    model: model ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/** Path to one cache entry: `<intentsDir>/cache/<key>.json`. */
function cacheEntryPath(intentsDir: string, key: string): string {
  return join(intentsDir, "cache", `${key}.json`);
}

/**
 * A filesystem-backed {@link ExtractionCache} storing each entry as a JSON file
 * under `<intentsDir>/cache/`. Reads return null on miss or malformed content so
 * a corrupt entry never breaks a run; writes are atomic.
 */
export function createFsExtractionCache(fs: JsonFs, intentsDir: string): ExtractionCache {
  return {
    async get(key) {
      const raw = await fs.read(cacheEntryPath(intentsDir, key));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as ExtractionResult;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      await fs.writeAtomic(cacheEntryPath(intentsDir, key), text);
    },
  };
}
