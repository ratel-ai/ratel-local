import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** Skip pathological multi-MB manifests (vendored monorepos, generated files). */
const MAX_MANIFEST_BYTES = 1_000_000;
/** Cap how many terms a single project can push into the BM25 query. */
const MAX_SIGNAL_TERMS = 200;

/**
 * Infer query terms describing a project's stack from files in `cwd`, so skill
 * ranking is biased toward the stack even when the prompt is terse ("build a
 * dashboard" in a Next.js repo → frontend terms; a `pyproject.toml` with Django
 * → django/backend terms).
 *
 * Ecosystem-agnostic: it reads the dependency manifests it can find
 * (`package.json`, `requirements.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
 * `Gemfile`, `composer.json`), emits each dependency's own name as terms (so any
 * package is covered without a hardcoded dictionary), and adds a small synonym
 * table only for vocabulary gaps (e.g. `next` → `react frontend`). Best-effort
 * and fail-soft: unreadable or absent files contribute nothing.
 *
 * Returns a de-duplicated list of lowercase terms (empty when nothing detected).
 */
export async function detectProjectSignals(cwd: string): Promise<string[]> {
  const terms = new Set<string>();

  for (const dep of await collectDependencies(cwd)) {
    for (const t of termsForDep(dep)) terms.add(t);
  }

  for (const rule of FILE_RULES) {
    if (await fileExists(join(cwd, rule.file))) {
      for (const t of rule.terms) terms.add(t);
    }
  }

  return [...terms].slice(0, MAX_SIGNAL_TERMS);
}

// ── Cached detection (used by the per-prompt preload hook) ───────────────────

interface SignalCache {
  [cwd: string]: { fingerprint: string; signals: string[] };
}

export interface DetectCacheOptions {
  /** On-disk cache path. Default: `~/.ratel/skill-signal-cache.json`. */
  cacheFile?: string;
}

export function defaultSignalCacheFile(home: string = homedir()): string {
  return join(home, ".ratel", "skill-signal-cache.json");
}

/** The files {@link detectProjectSignals} reads — used to fingerprint a project. */
function signalFiles(): string[] {
  return [
    ...new Set([
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "Gemfile",
      "composer.json",
      ...FILE_RULES.map((r) => r.file),
    ]),
  ];
}

/** Cheap fingerprint of a project's manifests (size + mtime), without reading them. */
async function fingerprint(cwd: string): Promise<string> {
  const parts: string[] = [];
  for (const f of signalFiles()) {
    try {
      const s = await stat(join(cwd, f));
      parts.push(`${f}:${Math.round(s.mtimeMs)}:${s.size}`);
    } catch {
      // absent → contributes nothing
    }
  }
  return parts.join("|");
}

/**
 * Cached {@link detectProjectSignals}: re-parses a project's manifests only when
 * one of them actually changes (a cheap `stat` fingerprint decides), so the
 * preload hook does NOT read and tokenize every manifest on *every* prompt — it
 * just stats them and reuses the last result. Fail-soft: any cache read/write
 * error falls back to a fresh detect.
 */
export async function detectProjectSignalsCached(
  cwd: string,
  opts: DetectCacheOptions = {},
): Promise<string[]> {
  const cacheFile = opts.cacheFile ?? defaultSignalCacheFile();
  const fp = await fingerprint(cwd);

  let cache: SignalCache = {};
  try {
    const parsed = JSON.parse(await readFile(cacheFile, "utf8"));
    if (parsed && typeof parsed === "object") cache = parsed as SignalCache;
  } catch {
    // missing or corrupt cache → recompute
  }

  const hit = cache[cwd];
  if (hit && hit.fingerprint === fp && Array.isArray(hit.signals)) {
    return hit.signals;
  }

  const signals = await detectProjectSignals(cwd);
  cache[cwd] = { fingerprint: fp, signals };
  try {
    await mkdir(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.ratel-tmp-${randomUUID()}`;
    await writeFile(tmp, `${JSON.stringify(cache)}\n`);
    await rename(tmp, cacheFile);
  } catch {
    // best-effort: the signals are returned regardless of whether the cache persisted
  }
  return signals;
}

// ── Dependency collection (per ecosystem) ───────────────────────────────────

async function collectDependencies(cwd: string): Promise<string[]> {
  const out = new Set<string>();
  const add = (names: Iterable<string>) => {
    for (const n of names) if (n) out.add(n);
  };

  add(await fromPackageJson(cwd));
  add(await fromRequirementsTxt(cwd));
  add(await fromPyproject(cwd));
  add(await fromCargo(cwd));
  add(await fromGoMod(cwd));
  add(await fromGemfile(cwd));
  add(await fromComposer(cwd));

  return [...out];
}

async function fromPackageJson(cwd: string): Promise<string[]> {
  const pkg = await readJson(join(cwd, "package.json"));
  if (!pkg) return [];
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (block && typeof block === "object") names.push(...Object.keys(block));
  }
  return names;
}

async function fromRequirementsTxt(cwd: string): Promise<string[]> {
  const raw = await readText(join(cwd, "requirements.txt"));
  if (raw === null) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map(pep508Name)
    .filter((n): n is string => n !== null);
}

async function fromPyproject(cwd: string): Promise<string[]> {
  const doc = await readTomlDoc(join(cwd, "pyproject.toml"));
  if (!doc) return [];
  const names = new Set<string>();
  // PEP 621: [project] dependencies + optional-dependencies
  const project = asRecord(doc.project);
  for (const req of asArray(project.dependencies)) {
    const n = pep508Name(String(req));
    if (n) names.add(n);
  }
  for (const group of Object.values(asRecord(project["optional-dependencies"]))) {
    for (const req of asArray(group)) {
      const n = pep508Name(String(req));
      if (n) names.add(n);
    }
  }
  // Poetry: [tool.poetry.dependencies] (object keys)
  const poetry = asRecord(asRecord(asRecord(doc.tool).poetry).dependencies);
  for (const name of Object.keys(poetry)) if (name.toLowerCase() !== "python") names.add(name);
  return [...names];
}

async function fromCargo(cwd: string): Promise<string[]> {
  const doc = await readTomlDoc(join(cwd, "Cargo.toml"));
  if (!doc) return [];
  const names = new Set<string>();
  for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) {
    for (const name of Object.keys(asRecord(doc[field]))) names.add(name);
  }
  return [...names];
}

async function fromGoMod(cwd: string): Promise<string[]> {
  const raw = await readText(join(cwd, "go.mod"));
  if (raw === null) return [];
  const names: string[] = [];
  // Matches both `require path vX` and the paths inside a `require ( ... )` block.
  const re = /^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+v\d/gm;
  for (const m of raw.matchAll(re)) names.push(stripModuleHost(m[1]));
  return names;
}

async function fromGemfile(cwd: string): Promise<string[]> {
  const raw = await readText(join(cwd, "Gemfile"));
  if (raw === null) return [];
  const names: string[] = [];
  for (const m of raw.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) names.push(m[1]);
  return names;
}

async function fromComposer(cwd: string): Promise<string[]> {
  const doc = await readJson(join(cwd, "composer.json"));
  if (!doc) return [];
  const names: string[] = [];
  for (const field of ["require", "require-dev"]) {
    const block = doc[field];
    if (block && typeof block === "object") {
      for (const name of Object.keys(block)) {
        if (name.toLowerCase() !== "php" && !name.startsWith("ext-")) names.push(name);
      }
    }
  }
  return names;
}

// ── Dependency → terms ──────────────────────────────────────────────────────

function termsForDep(dep: string): string[] {
  const tokens = tokenize(dep);
  const out = new Set<string>(tokens);
  // Apply synonyms for the whole name AND each token, so `laravel/framework`
  // and `react-dom` pick up their framework's concept words.
  for (const key of [dep.toLowerCase(), ...tokens]) {
    const synonyms = SYNONYMS[key];
    if (synonyms) for (const t of synonyms) out.add(t);
  }
  for (const [pattern, extra] of SYNONYM_PATTERNS) {
    if (pattern.test(dep)) for (const t of extra) out.add(t);
  }
  return [...out];
}

const STOP = new Set(["js", "ts", "io", "dev", "npm", "lib", "core", "common", "www", "go"]);

function tokenize(name: string): string[] {
  return name
    .replace(/^@/, "")
    .split(/[/\-_.]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 2 && !STOP.has(s));
}

// Vocabulary bridges: the package name alone doesn't carry the concept words.
const SYNONYMS: Record<string, string[]> = {
  next: ["next.js", "app router", "react", "frontend"],
  react: ["frontend", "components"],
  "react-dom": ["frontend"],
  vue: ["frontend", "components"],
  svelte: ["frontend"],
  tailwindcss: ["css", "styling"],
  prisma: ["database", "orm"],
  "drizzle-orm": ["database", "orm"],
  sqlalchemy: ["database", "orm"],
  express: ["backend", "api", "node"],
  fastify: ["backend", "api", "node"],
  django: ["backend", "web", "python"],
  flask: ["backend", "web", "python"],
  fastapi: ["backend", "api", "python"],
  rails: ["backend", "web", "ruby"],
  laravel: ["backend", "web", "php"],
  axum: ["backend", "api", "rust"],
  "actix-web": ["backend", "api", "rust"],
  stripe: ["payments", "billing"],
};

const SYNONYM_PATTERNS: ReadonlyArray<readonly [RegExp, string[]]> = [
  [/^@supabase\//, ["supabase", "auth", "database"]],
  [/^@angular\//, ["angular", "frontend"]],
  [/^@nestjs\//, ["nestjs", "backend", "api"]],
  [/^@prisma\//, ["prisma", "database", "orm"]],
  [/gin-gonic/, ["gin", "backend", "api"]],
];

// Marker files → language/framework terms (a fallback so a near-empty manifest
// still yields the language, and configs that imply a stack are caught).
const FILE_RULES: ReadonlyArray<{ file: string; terms: string[] }> = [
  { file: "supabase/config.toml", terms: ["supabase", "auth", "database"] },
  { file: "next.config.js", terms: ["next.js", "react", "frontend"] },
  { file: "next.config.ts", terms: ["next.js", "react", "frontend"] },
  { file: "next.config.mjs", terms: ["next.js", "react", "frontend"] },
  { file: "tailwind.config.js", terms: ["tailwind", "css", "styling"] },
  { file: "tailwind.config.ts", terms: ["tailwind", "css", "styling"] },
  { file: "manage.py", terms: ["django", "python", "backend"] },
  { file: "Cargo.toml", terms: ["rust", "cargo"] },
  { file: "pyproject.toml", terms: ["python"] },
  { file: "requirements.txt", terms: ["python"] },
  { file: "go.mod", terms: ["go", "golang"] },
  { file: "Gemfile", terms: ["ruby"] },
  { file: "composer.json", terms: ["php"] },
];

// ── Small parsing/IO helpers ────────────────────────────────────────────────

/** Extract the package name from a PEP 508 requirement string. */
function pep508Name(req: string): string | null {
  const m = req.trim().match(/^([A-Za-z0-9._-]+)/);
  return m ? m[1] : null;
}

/** Drop the host segment of a Go module path (e.g. `github.com/...`). */
function stripModuleHost(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 && parts[0].includes(".") ? parts.slice(1).join("/") : path;
}

async function readText(path: string): Promise<string | null> {
  try {
    if ((await stat(path)).size > MAX_MANIFEST_BYTES) return null; // skip pathological files
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function readTomlDoc(path: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path);
  if (raw === null) return null;
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
