import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjectSignals } from "./signals.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-signals-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("detectProjectSignals", () => {
  it("returns nothing for an empty directory", async () => {
    expect(await detectProjectSignals(dir)).toEqual([]);
  });

  it("derives frontend terms from package.json deps (next/react)", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15", react: "19" } }),
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toContain("next.js");
    expect(terms).toContain("frontend");
    expect(terms).toContain("react");
  });

  it("detects supabase from a scoped dependency", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@supabase/supabase-js": "2" } }),
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toContain("supabase");
    expect(terms).toContain("database");
  });

  it("detects stack from marker files (Cargo.toml, supabase/config.toml)", async () => {
    await writeFile(join(dir, "Cargo.toml"), "[package]");
    await mkdir(join(dir, "supabase"), { recursive: true });
    await writeFile(join(dir, "supabase", "config.toml"), "");
    const terms = await detectProjectSignals(dir);
    expect(terms).toContain("rust");
    expect(terms).toContain("supabase");
  });

  it("de-duplicates overlapping terms", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { next: "15" }, devDependencies: { react: "19" } }),
    );
    await writeFile(join(dir, "next.config.js"), "module.exports = {}");
    const terms = await detectProjectSignals(dir);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("survives malformed package.json", async () => {
    await writeFile(join(dir, "package.json"), "{ not json");
    expect(await detectProjectSignals(dir)).toEqual([]);
  });
});
