import { describe, expect, it, vi } from "vitest";
import type { AnalysisConfig } from "../config.js";
import {
  AnthropicApiSkillGenerator,
  buildSkillPrompt,
  ClaudeCliSkillGenerator,
  createSkillGenerator,
  parseSkillDraft,
} from "./skill-generator.js";
import type { Intent } from "./types.js";

const INTENT: Intent = { content: "Add OAuth login to a Next.js app" };

const DRAFT_JSON = JSON.stringify({
  name: "nextjs-oauth-login",
  description: "Add OAuth login to a Next.js app",
  tags: ["nextjs", "auth", "oauth"],
  body: "# OAuth in Next.js\n\nUse the App Router...",
});

describe("buildSkillPrompt", () => {
  it("always asks for a single JSON object", () => {
    const prompt = buildSkillPrompt(INTENT);
    expect(prompt).toMatch(/Respond with ONLY a single JSON object/);
    expect(prompt).toContain('"name"');
    expect(prompt).toContain('"body"');
  });

  it("omits the evidence and related sections when absent", () => {
    const prompt = buildSkillPrompt(INTENT);
    expect(prompt).not.toMatch(/What the user actually did/i);
    expect(prompt).not.toMatch(/Related things the user repeatedly asks/i);
  });

  it("includes the evidence section with bullets when evidences provided", () => {
    const prompt = buildSkillPrompt(INTENT, {
      evidences: ["ran `npm run build`", "asked how to wire OAuth callback"],
    });
    expect(prompt).toMatch(/What the user actually did/i);
    expect(prompt).toContain("- ran `npm run build`");
    expect(prompt).toContain("- asked how to wire OAuth callback");
  });

  it("includes the related section with bullets when relatedIntents provided", () => {
    const prompt = buildSkillPrompt(INTENT, {
      relatedIntents: ["add logout flow", "refresh tokens"],
    });
    expect(prompt).toMatch(/Related things the user repeatedly asks/i);
    expect(prompt).toContain("- add logout flow");
    expect(prompt).toContain("- refresh tokens");
  });

  it("keeps the existing existingSkillIds dedup line", () => {
    const prompt = buildSkillPrompt(INTENT, { existingSkillIds: ["api-design"] });
    expect(prompt).toMatch(/do not duplicate these/i);
    expect(prompt).toContain("api-design");
  });

  it("caps the number of evidence bullets", () => {
    const evidences = Array.from({ length: 50 }, (_, i) => `evidence number ${i}`);
    const prompt = buildSkillPrompt(INTENT, { evidences });
    const bulletCount = prompt.split("\n").filter((l) => l.startsWith("- evidence number")).length;
    expect(bulletCount).toBeLessThanOrEqual(12);
    expect(bulletCount).toBeGreaterThan(0);
  });

  it("caps the length of each evidence bullet", () => {
    const long = "x".repeat(5000);
    const prompt = buildSkillPrompt(INTENT, { evidences: [long] });
    const bullet = prompt.split("\n").find((l) => l.startsWith("- xxx"));
    expect(bullet).toBeDefined();
    // bullet = "- " + capped content (+ optional ellipsis); stay well under the raw length.
    expect((bullet as string).length).toBeLessThanOrEqual(2 + 300 + 1);
  });
});

describe("parseSkillDraft", () => {
  it("parses a bare JSON object", () => {
    const draft = parseSkillDraft(DRAFT_JSON);
    expect(draft.name).toBe("nextjs-oauth-login");
    expect(draft.tags).toEqual(["nextjs", "auth", "oauth"]);
  });

  it("extracts JSON wrapped in markdown fences and prose", () => {
    const wrapped = `Here is the skill:\n\n\`\`\`json\n${DRAFT_JSON}\n\`\`\`\nHope it helps!`;
    const draft = parseSkillDraft(wrapped);
    expect(draft.name).toBe("nextjs-oauth-login");
  });

  it("slugifies an unsafe name", () => {
    const draft = parseSkillDraft(
      JSON.stringify({ name: "OAuth Login!!", description: "d", body: "b" }),
    );
    expect(draft.name).toBe("oauth-login");
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseSkillDraft("sorry, I cannot")).toThrow(/draft/i);
  });

  it("throws when required fields are missing", () => {
    expect(() => parseSkillDraft(JSON.stringify({ name: "x" }))).toThrow(/description|body/i);
  });
});

describe("AnthropicApiSkillGenerator", () => {
  it("calls the messages API and returns a parsed draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: DRAFT_JSON }] }), {
        status: 200,
      }),
    );
    const gen = new AnthropicApiSkillGenerator(
      { apiKey: "sk-ant", model: "claude-sonnet-4-6" },
      { fetch: fetchMock },
    );
    const draft = await gen.generate(INTENT, { existingSkillIds: ["api-design"] });
    expect(draft.name).toBe("nextjs-oauth-login");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(JSON.parse(init.body as string).model).toBe("claude-sonnet-4-6");
  });

  it("requires an apiKey", () => {
    expect(() => new AnthropicApiSkillGenerator({})).toThrow(/apiKey/i);
  });
});

describe("ClaudeCliSkillGenerator", () => {
  it("spawns claude -p and parses stdout", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ stdout: DRAFT_JSON, stderr: "", code: 0 });
    const gen = new ClaudeCliSkillGenerator({}, { spawn: spawnMock });
    const draft = await gen.generate(INTENT);
    expect(draft.name).toBe("nextjs-oauth-login");
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args).toContain("-p");
    // Skips loading the user's MCP servers, which otherwise boot on every call.
    expect(args).toContain("--strict-mcp-config");
  });

  it("throws when the CLI exits non-zero", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "not found", code: 127 });
    const gen = new ClaudeCliSkillGenerator({}, { spawn: spawnMock });
    await expect(gen.generate(INTENT)).rejects.toThrow(/claude/i);
  });
});

describe("createSkillGenerator", () => {
  it("auto → anthropic-api when an apiKey is configured", () => {
    const cfg: AnalysisConfig = { skillGen: { provider: "auto", apiKey: "sk-ant" } };
    expect(createSkillGenerator(cfg)).toBeInstanceOf(AnthropicApiSkillGenerator);
  });

  it("auto → claude-cli when no apiKey is configured", () => {
    const cfg: AnalysisConfig = { skillGen: { provider: "auto" } };
    expect(createSkillGenerator(cfg)).toBeInstanceOf(ClaudeCliSkillGenerator);
  });

  it("defaults to auto when skillGen is absent", () => {
    expect(createSkillGenerator({})).toBeInstanceOf(ClaudeCliSkillGenerator);
  });

  it("honors an explicit anthropic-api provider", () => {
    const cfg: AnalysisConfig = { skillGen: { provider: "anthropic-api", apiKey: "sk" } };
    expect(createSkillGenerator(cfg)).toBeInstanceOf(AnthropicApiSkillGenerator);
  });

  it("honors an explicit claude-cli provider even with an apiKey", () => {
    const cfg: AnalysisConfig = { skillGen: { provider: "claude-cli", apiKey: "sk" } };
    expect(createSkillGenerator(cfg)).toBeInstanceOf(ClaudeCliSkillGenerator);
  });

  it("passes the configured model through the API path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: DRAFT_JSON }] }), {
        status: 200,
      }),
    );
    const cfg: AnalysisConfig = {
      skillGen: { provider: "auto", apiKey: "sk-ant", model: "claude-opus-4-6" },
    };
    const gen = createSkillGenerator(cfg, { anthropic: { fetch: fetchMock } });
    expect(gen).toBeInstanceOf(AnthropicApiSkillGenerator);
    await gen.generate(INTENT);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string).model).toBe("claude-opus-4-6");
  });

  it("passes the configured model through the claude-cli path", async () => {
    const spawnMock = vi.fn().mockResolvedValue({ stdout: DRAFT_JSON, stderr: "", code: 0 });
    const cfg: AnalysisConfig = {
      skillGen: { provider: "claude-cli", model: "sonnet" },
    };
    const gen = createSkillGenerator(cfg, { cli: { spawn: spawnMock } });
    expect(gen).toBeInstanceOf(ClaudeCliSkillGenerator);
    await gen.generate(INTENT);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
  });
});
