import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnalysisConfig, type HierarchyEnv, nodeJsonFs, writeJson } from "@ratel-ai/mcp-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  maskAnalysis,
  mergeAnalysisSecrets,
  readAnalysisSettings,
  SECRET_MASK,
  writeAnalysisSettings,
} from "./analysis-settings.js";

describe("maskAnalysis", () => {
  it("masks present apiKeys and leaves the rest intact", () => {
    const masked = maskAnalysis({
      enabled: true,
      extractor: { endpoint: "http://x", apiKey: "sk-secret" },
      skillGen: { provider: "anthropic-api", apiKey: "sk-ant" },
    });
    expect(masked.extractor?.apiKey).toBe(SECRET_MASK);
    expect(masked.extractor?.endpoint).toBe("http://x");
    expect(masked.skillGen?.apiKey).toBe(SECRET_MASK);
  });

  it("leaves missing apiKeys untouched", () => {
    const masked = maskAnalysis({ extractor: { endpoint: "http://x" } });
    expect(masked.extractor?.apiKey).toBeUndefined();
  });
});

describe("mergeAnalysisSecrets", () => {
  const existing: AnalysisConfig = {
    extractor: { endpoint: "http://old", apiKey: "real-extractor-key" },
    skillGen: { provider: "anthropic-api", apiKey: "real-skill-key" },
  };

  it("keeps the existing secret when the mask is sent back", () => {
    const merged = mergeAnalysisSecrets(
      { extractor: { endpoint: "http://new", apiKey: SECRET_MASK } },
      existing,
    );
    expect(merged.extractor?.apiKey).toBe("real-extractor-key");
    expect(merged.extractor?.endpoint).toBe("http://new");
  });

  it("replaces the secret when a new value is sent", () => {
    const merged = mergeAnalysisSecrets({ extractor: { apiKey: "brand-new" } }, existing);
    expect(merged.extractor?.apiKey).toBe("brand-new");
  });

  it("clears the secret when an empty string is sent", () => {
    const merged = mergeAnalysisSecrets(
      { extractor: { endpoint: "http://x", apiKey: "" } },
      existing,
    );
    expect(merged.extractor?.apiKey).toBeUndefined();
  });
});

describe("read/write round-trip", () => {
  let dir: string;
  let env: HierarchyEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ratel-settings-"));
    env = { homeDir: dir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists settings, masks on read, and preserves the real secret on disk", async () => {
    await writeAnalysisSettings(env, nodeJsonFs, {
      enabled: true,
      cadence: { everyNMessages: 7, onIdle: true },
      extractor: { endpoint: "http://127.0.0.1:8723", apiKey: "sk-real" },
    });

    const read = await readAnalysisSettings(env, nodeJsonFs);
    expect(read.extractor?.apiKey).toBe(SECRET_MASK);
    expect(read.cadence?.everyNMessages).toBe(7);

    // a no-op save (mask echoed back) must keep the real key
    await writeAnalysisSettings(env, nodeJsonFs, {
      enabled: true,
      cadence: { everyNMessages: 7, onIdle: true },
      extractor: { endpoint: "http://127.0.0.1:8723", apiKey: SECRET_MASK },
    });
    const config = JSON.parse((await nodeJsonFs.read(join(dir, ".ratel", "config.json"))) ?? "{}");
    expect(config.analysis.extractor.apiKey).toBe("sk-real");
  });

  it("preserves other top-level config keys when writing analysis", async () => {
    await writeJson(nodeJsonFs, join(dir, ".ratel", "config.json"), {
      mcpServers: { fs: { type: "stdio", command: "echo" } },
      skills: { dirs: ["/x"] },
    });
    await writeAnalysisSettings(env, nodeJsonFs, { enabled: true });
    const config = JSON.parse((await nodeJsonFs.read(join(dir, ".ratel", "config.json"))) ?? "{}");
    expect(config.mcpServers.fs.command).toBe("echo");
    expect(config.skills.dirs).toEqual(["/x"]);
    expect(config.analysis.enabled).toBe(true);
  });

  it("rejects an invalid analysis block", async () => {
    await expect(
      writeAnalysisSettings(env, nodeJsonFs, {
        cadence: { everyNMessages: -1 },
      } as AnalysisConfig),
    ).rejects.toThrow(/everyNMessages/);
  });
});
