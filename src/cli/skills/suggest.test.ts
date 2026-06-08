import type { Skill } from "@ratel-ai/sdk";
import { describe, expect, it } from "vitest";
import { suggestSkills } from "./suggest.js";

function skill(id: string, description: string, tags: string[] = []): Skill {
  return { id, name: id, description, tags, body: `# ${id}` };
}

const CATALOG: Skill[] = [
  skill("frontend-patterns", "React and Next.js component patterns, hooks, and conventions.", [
    "frontend",
    "react",
  ]),
  skill("supabase-auth", "Supabase auth: sessions, RLS, and the SSR client.", ["supabase"]),
  skill("rust-style", "Idiomatic Rust ownership and error handling.", ["rust"]),
];

const deps = {
  loadSkills: async () => CATALOG,
};

describe("suggestSkills", () => {
  it("ranks by the prompt text alone", async () => {
    const out = await suggestSkills(
      { prompt: "help me with supabase row level security", dirs: ["x"] },
      deps,
    );
    expect(out[0]?.skillId).toBe("supabase-auth");
  });

  it("uses project signals to surface a skill the terse prompt never names", async () => {
    // "build a dashboard" has no frontend words; the Next.js project signal supplies them.
    const out = await suggestSkills(
      {
        prompt: "build a dashboard",
        cwd: "/proj",
        dirs: ["x"],
        limit: 1,
      },
      { ...deps, detectProjectSignals: async () => ["next.js", "react", "frontend"] },
    );
    expect(out[0]?.skillId).toBe("frontend-patterns");
  });

  it("respects the limit", async () => {
    const out = await suggestSkills(
      { prompt: "rust frontend supabase", dirs: ["x"], limit: 2 },
      deps,
    );
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it("drops hits below minScore", async () => {
    const out = await suggestSkills(
      { prompt: "supabase auth", dirs: ["x"], minScore: 1_000_000 },
      deps,
    );
    expect(out).toEqual([]);
  });

  it("returns nothing when the catalog is empty", async () => {
    const out = await suggestSkills(
      { prompt: "anything", dirs: ["x"] },
      { loadSkills: async () => [] },
    );
    expect(out).toEqual([]);
  });
});
