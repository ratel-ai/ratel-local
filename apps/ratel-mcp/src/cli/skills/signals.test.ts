import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjectSignals, detectProjectSignalsCached } from "./signals.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ratel-signals-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (rel: string, contents: string) => writeFile(join(dir, rel), contents);

describe("detectProjectSignals — Node", () => {
  it("returns nothing for an empty directory", async () => {
    expect(await detectProjectSignals(dir)).toEqual([]);
  });

  it("derives frontend terms from next/react via synonyms", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15", react: "19" } }));
    const terms = await detectProjectSignals(dir);
    expect(terms).toContain("next.js");
    expect(terms).toContain("frontend");
    expect(terms).toContain("react");
  });

  it("emits raw dependency-name tokens for packages not in any table", async () => {
    await write(
      "package.json",
      JSON.stringify({ dependencies: { "@tanstack/react-query": "5", zustand: "4" } }),
    );
    const terms = await detectProjectSignals(dir);
    // no hardcoded rule for these — their own names become the signal
    expect(terms).toEqual(expect.arrayContaining(["tanstack", "react", "query", "zustand"]));
  });

  it("detects supabase from a scoped dependency (pattern synonym)", async () => {
    await write("package.json", JSON.stringify({ dependencies: { "@supabase/supabase-js": "2" } }));
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["supabase", "database"]));
  });

  it("de-duplicates overlapping terms", async () => {
    await write("package.json", JSON.stringify({ dependencies: { next: "15" } }));
    await write("next.config.js", "module.exports = {}");
    const terms = await detectProjectSignals(dir);
    expect(new Set(terms).size).toBe(terms.length);
  });

  it("survives malformed package.json", async () => {
    await write("package.json", "{ not json");
    expect(await detectProjectSignals(dir)).toEqual([]);
  });
});

describe("detectProjectSignals — Python", () => {
  it("detects django from requirements.txt (name + synonyms)", async () => {
    await write("requirements.txt", "Django>=4.2,<5\npsycopg2-binary\n# a comment\n");
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["django", "backend", "python"]));
  });

  it("detects fastapi from a PEP 621 pyproject.toml", async () => {
    await write(
      "pyproject.toml",
      '[project]\nname = "x"\ndependencies = ["fastapi>=0.110", "uvicorn[standard]"]\n',
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["fastapi", "api", "python", "uvicorn"]));
  });

  it("detects deps from a Poetry pyproject.toml and skips the python pin", async () => {
    await write(
      "pyproject.toml",
      '[tool.poetry.dependencies]\npython = "^3.11"\ndjango = "^5.0"\n',
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toContain("django");
  });
});

describe("detectProjectSignals — Rust / Go / Ruby / PHP", () => {
  it("detects rust crates from Cargo.toml", async () => {
    await write("Cargo.toml", '[package]\nname = "x"\n[dependencies]\naxum = "0.7"\nserde = "1"\n');
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["rust", "axum", "backend", "serde"]));
  });

  it("detects go modules from go.mod, dropping the host segment", async () => {
    await write(
      "go.mod",
      "module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n",
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["golang", "gin"]));
    expect(terms).not.toContain("github"); // host segment stripped
  });

  it("detects gems from a Gemfile", async () => {
    await write("Gemfile", "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n");
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["ruby", "rails", "backend"]));
  });

  it("detects composer packages, skipping php/ext-*", async () => {
    await write(
      "composer.json",
      JSON.stringify({ require: { php: "^8.2", "laravel/framework": "^11", "ext-pdo": "*" } }),
    );
    const terms = await detectProjectSignals(dir);
    expect(terms).toEqual(expect.arrayContaining(["php", "laravel", "framework", "web"]));
  });

  it("skips a pathologically large manifest instead of reading it", async () => {
    const huge = `{"dependencies":{"react":"1"},"_pad":"${"x".repeat(1_100_000)}"}`;
    await writeFile(join(dir, "package.json"), huge);
    // over the 1 MB cap → not read → no terms derived from it
    expect(await detectProjectSignals(dir)).toEqual([]);
  });
});

describe("detectProjectSignalsCached", () => {
  it("caches by manifest fingerprint and invalidates when a manifest changes", async () => {
    const cacheFile = join(dir, "cache.json");
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { react: "1" } }));

    const first = await detectProjectSignalsCached(dir, { cacheFile });
    expect(first).toEqual(expect.arrayContaining(["react", "frontend"]));

    // Tamper the cached signals but keep the fingerprint: a cache HIT returns them.
    const cache = JSON.parse(await readFile(cacheFile, "utf8"));
    cache[dir].signals = ["SENTINEL"];
    await writeFile(cacheFile, JSON.stringify(cache));
    expect(await detectProjectSignalsCached(dir, { cacheFile })).toEqual(["SENTINEL"]);

    // Changing the manifest changes the fingerprint → recompute, not the stale sentinel.
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { vue: "1" } }));
    const after = await detectProjectSignalsCached(dir, { cacheFile });
    expect(after).not.toContain("SENTINEL");
    expect(after).toEqual(expect.arrayContaining(["vue"]));
  });
});
