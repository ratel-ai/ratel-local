import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatTurn, ExtractionResult } from "@ratel-ai/mcp-core";
import { nodeJsonFs } from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheKey, createFsExtractionCache } from "./extraction-cache.js";

const TURNS: ChatTurn[] = [
  { role: "user", content: "add oauth login" },
  { role: "assistant", content: "ok" },
];

const RESULT: ExtractionResult = {
  claims: [{ subtype: "user_assertion", content: "wants oauth" }],
  intents: [{ content: "add oauth login" }],
};

describe("cacheKey", () => {
  it("is deterministic for identical inputs", () => {
    expect(cacheKey(TURNS, "m1")).toBe(cacheKey(TURNS, "m1"));
  });

  it("is a 64-char hex sha256 digest", () => {
    expect(cacheKey(TURNS, "m1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the model id changes", () => {
    expect(cacheKey(TURNS, "m1")).not.toBe(cacheKey(TURNS, "m2"));
  });

  it("distinguishes a missing model from a present one", () => {
    expect(cacheKey(TURNS)).not.toBe(cacheKey(TURNS, "m1"));
  });

  it("changes when the turns change", () => {
    const other: ChatTurn[] = [{ role: "user", content: "deploy app" }];
    expect(cacheKey(TURNS, "m1")).not.toBe(cacheKey(other, "m1"));
  });
});

describe("createFsExtractionCache", () => {
  let intentsDir: string;

  beforeEach(async () => {
    intentsDir = await mkdtemp(join(tmpdir(), "ratel-cache-"));
  });

  afterEach(async () => {
    await rm(intentsDir, { recursive: true, force: true });
  });

  it("returns null on a miss", async () => {
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    expect(await cache.get(cacheKey(TURNS, "m1"))).toBeNull();
  });

  it("round-trips a value through the filesystem", async () => {
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    const key = cacheKey(TURNS, "m1");
    await cache.set(key, RESULT);
    expect(await cache.get(key)).toEqual(RESULT);
  });

  it("stores entries under <intentsDir>/cache/<key>.json", async () => {
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    const key = cacheKey(TURNS, "m1");
    await cache.set(key, RESULT);
    expect(await nodeJsonFs.exists(join(intentsDir, "cache", `${key}.json`))).toBe(true);
  });

  it("returns null on a malformed cache file", async () => {
    const cache = createFsExtractionCache(nodeJsonFs, intentsDir);
    const key = cacheKey(TURNS, "m1");
    await nodeJsonFs.writeAtomic(join(intentsDir, "cache", `${key}.json`), "{ not json");
    expect(await cache.get(key)).toBeNull();
  });
});
