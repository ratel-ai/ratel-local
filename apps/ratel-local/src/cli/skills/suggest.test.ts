import type { Skill } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { suggestSkills } from "./suggest.js";

function skill(
  id: string,
  description: string,
  opts: { tags?: string[]; triggers?: string[]; stacks?: string[] } = {},
): Skill {
  return {
    id,
    name: id,
    description,
    // SDK 0.2.0 (ratel ADR-0012): triggers fold into the indexed `tags`; stacks
    // move under non-indexed `metadata`.
    tags: [...(opts.tags ?? []), ...(opts.triggers ?? [])],
    metadata: { stacks: opts.stacks ?? [] },
    body: `# ${id}`,
  };
}

const CATALOG: Skill[] = [
  skill("frontend-react", "React component patterns and conventions.", {
    triggers: ["dashboard", "component", "page"],
    stacks: ["react", "next"],
  }),
  skill("frontend-vue", "Vue component patterns and conventions.", {
    triggers: ["dashboard", "component", "page"],
    stacks: ["vue"],
  }),
  skill("supabase-auth", "Supabase auth: sessions, RLS, SSR client.", {
    triggers: ["login", "auth", "sign in"],
    stacks: ["supabase"],
  }),
];

const deps = { loadSkills: async () => CATALOG };

describe("suggestSkills — triggers", () => {
  it("matches a terse intent prompt via the skill's trigger phrase", async () => {
    // "set up login" shares no words with the description, but matches the trigger.
    const out = await suggestSkills({ prompt: "set up login", dirs: ["x"] }, deps);
    expect(out[0]?.skillId).toBe("supabase-auth");
  });

  it('"build a dashboard" matches the frontend trigger', async () => {
    const out = await suggestSkills({ prompt: "build a dashboard", dirs: ["x"], limit: 5 }, deps);
    expect(out.map((s) => s.skillId)).toContain("frontend-react");
  });
});

describe("suggestSkills — stack boost", () => {
  it("project context re-orders tied skills toward the matching stack", async () => {
    // react + vue skills tie on the trigger; the React project boosts the React one.
    const out = await suggestSkills(
      { prompt: "build a dashboard component", cwd: "/proj", dirs: ["x"], limit: 2 },
      { ...deps, detectProjectSignals: async () => ["react", "next"] },
    );
    expect(out[0]?.skillId).toBe("frontend-react");
    expect(out[0]?.stackMatch).toBe(true);
  });

  it("signals are a boost, NOT a query term (no project → no stack bias)", async () => {
    const out = await suggestSkills(
      { prompt: "build a dashboard component", dirs: ["x"], limit: 2 },
      deps,
    );
    // both surface; neither is stack-boosted
    expect(out.every((s) => s.stackMatch !== true)).toBe(true);
  });
});

describe("suggestSkills — clear-winner gate (push path)", () => {
  it("fires nothing when two skills tie and no project context disambiguates", async () => {
    const out = await suggestSkills(
      { prompt: "build a dashboard component", dirs: ["x"], requireClearWinner: true, limit: 1 },
      deps,
    );
    expect(out).toEqual([]);
  });

  it("fires the clear winner once the project context breaks the tie", async () => {
    const out = await suggestSkills(
      {
        prompt: "build a dashboard component",
        cwd: "/proj",
        dirs: ["x"],
        requireClearWinner: true,
        limit: 1,
      },
      { ...deps, detectProjectSignals: async () => ["react", "next"] },
    );
    expect(out[0]?.skillId).toBe("frontend-react");
  });

  it("a clear lexical winner is NOT overridden by the project stack (#4)", async () => {
    // The prompt is strongly about supabase auth (clear lexical winner), but the
    // project is React — so frontend-react is stack-matched and supabase-auth is
    // not. The stack must bias ties, never override a clearly-stronger match.
    const out = await suggestSkills(
      {
        prompt: "supabase auth sessions and rls policies",
        cwd: "/proj",
        dirs: ["x"],
        requireClearWinner: true,
        limit: 1,
      },
      { ...deps, detectProjectSignals: async () => ["react", "next"] },
    );
    expect(out[0]?.skillId).toBe("supabase-auth");
  });
});

describe("suggestSkills — guards", () => {
  it("returns nothing for an empty prompt", async () => {
    expect(await suggestSkills({ prompt: "   ", dirs: ["x"] }, deps)).toEqual([]);
  });

  it("returns nothing for an empty catalog", async () => {
    const out = await suggestSkills(
      { prompt: "anything", dirs: ["x"] },
      { loadSkills: async () => [] },
    );
    expect(out).toEqual([]);
  });

  it("drops hits below minScore", async () => {
    const out = await suggestSkills({ prompt: "login", dirs: ["x"], minScore: 1_000_000 }, deps);
    expect(out).toEqual([]);
  });
});
