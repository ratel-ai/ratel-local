import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Infer query terms describing a project's stack from files in `cwd`, so skill
 * ranking is biased toward the stack even when the prompt is terse ("build a
 * dashboard" in a Next.js repo → frontend terms). Best-effort and fail-soft:
 * unreadable or absent files contribute nothing.
 *
 * Returns a de-duplicated list of lowercase terms (empty when nothing detected).
 */
export async function detectProjectSignals(cwd: string): Promise<string[]> {
  const terms = new Set<string>();
  const deps = await readPackageDeps(cwd);

  for (const rule of DEP_RULES) {
    if (deps.some((d) => (rule.dep instanceof RegExp ? rule.dep.test(d) : d === rule.dep))) {
      for (const t of rule.terms) terms.add(t);
    }
  }

  for (const rule of FILE_RULES) {
    if (await fileExists(join(cwd, rule.file))) {
      for (const t of rule.terms) terms.add(t);
    }
  }

  return [...terms];
}

interface DepRule {
  dep: string | RegExp;
  terms: string[];
}

interface FileRule {
  file: string;
  terms: string[];
}

// Dependency name (from package.json) → stack terms.
const DEP_RULES: DepRule[] = [
  { dep: /^@supabase\//, terms: ["supabase", "auth", "database", "postgres"] },
  { dep: "next", terms: ["next.js", "app router", "react", "frontend"] },
  { dep: "react", terms: ["react", "frontend", "components"] },
  { dep: "react-dom", terms: ["react", "frontend"] },
  { dep: "vue", terms: ["vue", "frontend", "components"] },
  { dep: "svelte", terms: ["svelte", "frontend"] },
  { dep: "@angular/core", terms: ["angular", "frontend"] },
  { dep: "tailwindcss", terms: ["tailwind", "css", "styling"] },
  { dep: "@prisma/client", terms: ["prisma", "database", "orm"] },
  { dep: "prisma", terms: ["prisma", "database", "orm"] },
  { dep: "drizzle-orm", terms: ["drizzle", "database", "orm"] },
  { dep: "express", terms: ["express", "backend", "api", "node"] },
  { dep: "fastify", terms: ["fastify", "backend", "api", "node"] },
  { dep: /^@nestjs\//, terms: ["nestjs", "backend", "api"] },
  { dep: "stripe", terms: ["stripe", "payments", "billing"] },
  { dep: "vite", terms: ["vite", "frontend", "build"] },
];

// Marker file (relative to cwd) → stack terms.
const FILE_RULES: FileRule[] = [
  { file: "supabase/config.toml", terms: ["supabase", "auth", "database"] },
  { file: "next.config.js", terms: ["next.js", "react", "frontend"] },
  { file: "next.config.ts", terms: ["next.js", "react", "frontend"] },
  { file: "next.config.mjs", terms: ["next.js", "react", "frontend"] },
  { file: "tailwind.config.js", terms: ["tailwind", "css", "styling"] },
  { file: "tailwind.config.ts", terms: ["tailwind", "css", "styling"] },
  { file: "prisma/schema.prisma", terms: ["prisma", "database", "orm"] },
  { file: "Cargo.toml", terms: ["rust", "cargo"] },
  { file: "pyproject.toml", terms: ["python"] },
  { file: "requirements.txt", terms: ["python"] },
  { file: "go.mod", terms: ["go", "golang"] },
  { file: "Gemfile", terms: ["ruby", "rails"] },
  { file: "composer.json", terms: ["php"] },
];

async function readPackageDeps(cwd: string): Promise<string[]> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = pkg[field];
      if (block && typeof block === "object") {
        for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
      }
    }
    return [...names];
  } catch {
    return [];
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
