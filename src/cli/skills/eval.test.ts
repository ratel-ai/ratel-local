import type { Skill } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { suggestSkills } from "./suggest.js";

/**
 * Offline push-retrieval benchmark. Measures the push methodology (BM25 +
 * triggers + stack-boost + clear-winner gate) against a labeled corpus that
 * includes NEGATIVES — prompts where nothing should fire. Two headline numbers:
 *
 *   recall@1     — of the positive cases, how often the gold skill is the (single) fire
 *   over-fire    — of the negative cases, how often we wrongly fired anything
 *
 * This is the instrument for tuning thresholds and deciding whether semantic /
 * LLM layers are worth their cost. Expand `CORPUS` with real hand-labeled cases.
 */

function skill(id: string, description: string, triggers: string[], stacks: string[]): Skill {
  return { id, name: id, description, tags: [], triggers, stacks, body: `# ${id}` };
}

const SKILLS: Skill[] = [
  skill(
    "frontend-react",
    "React/Next component patterns and conventions.",
    ["dashboard", "page", "component", "form", "modal"],
    ["react", "next"],
  ),
  skill(
    "frontend-vue",
    "Vue component patterns and conventions.",
    ["dashboard", "page", "component"],
    ["vue"],
  ),
  skill(
    "supabase-auth",
    "Supabase auth: sessions, RLS, SSR client.",
    ["login", "sign in", "authentication", "row level security"],
    ["supabase"],
  ),
  skill(
    "django-conventions",
    "Django backend conventions: views, models, DRF.",
    ["endpoint", "model", "serializer", "migration"],
    ["django", "python"],
  ),
  skill(
    "rust-style",
    "Idiomatic Rust ownership and error handling.",
    ["ownership", "lifetime", "trait"],
    ["rust"],
  ),
];

interface Case {
  prompt: string;
  stacks: string[];
  gold: string | null; // null = negative (nothing should fire)
}

const CORPUS: Case[] = [
  // positives
  { prompt: "build me a dashboard", stacks: ["react", "next"], gold: "frontend-react" },
  { prompt: "create a settings page", stacks: ["react"], gold: "frontend-react" },
  { prompt: "add a login form", stacks: ["react"], gold: "supabase-auth" },
  { prompt: "set up row level security", stacks: ["supabase"], gold: "supabase-auth" },
  {
    prompt: "add an endpoint for orders",
    stacks: ["django", "python"],
    gold: "django-conventions",
  },
  { prompt: "write a serializer for the model", stacks: ["python"], gold: "django-conventions" },
  // negatives — nothing should fire
  { prompt: "fix this typo", stacks: ["react"], gold: null },
  { prompt: "what does this function do", stacks: ["django"], gold: null },
  { prompt: "rename this variable", stacks: ["rust"], gold: null },
  { prompt: "bump the version number", stacks: ["react"], gold: null },
];

async function runCase(c: Case): Promise<string | null> {
  const out = await suggestSkills(
    { prompt: c.prompt, cwd: "/proj", dirs: ["x"], requireClearWinner: true, limit: 1 },
    { loadSkills: async () => SKILLS, detectProjectSignals: async () => c.stacks },
  );
  return out[0]?.skillId ?? null;
}

describe("push-retrieval benchmark", () => {
  it("reports recall@1 and over-fire rate, and meets the seed baseline", async () => {
    const positives = CORPUS.filter((c) => c.gold !== null);
    const negatives = CORPUS.filter((c) => c.gold === null);

    let correct = 0;
    const misses: string[] = [];
    for (const c of positives) {
      const got = await runCase(c);
      if (got === c.gold) correct++;
      else misses.push(`${c.prompt} → got ${got ?? "∅"}, want ${c.gold}`);
    }

    let overFired = 0;
    const overFires: string[] = [];
    for (const c of negatives) {
      const got = await runCase(c);
      if (got !== null) {
        overFired++;
        overFires.push(`${c.prompt} → ${got}`);
      }
    }

    const recallAt1 = correct / positives.length;
    const overFireRate = overFired / negatives.length;

    // The report (visible with `vitest --reporter verbose` or on failure).
    console.log(
      `[push-eval] recall@1=${recallAt1.toFixed(2)} (${correct}/${positives.length}) ` +
        `over-fire=${overFireRate.toFixed(2)} (${overFired}/${negatives.length})` +
        (misses.length ? `\n  misses: ${misses.join("; ")}` : "") +
        (overFires.length ? `\n  over-fires: ${overFires.join("; ")}` : ""),
    );

    // Seed baseline — tighten as the corpus grows.
    expect(recallAt1).toBeGreaterThanOrEqual(0.8);
    expect(overFireRate).toBe(0);
  });
});
