import { describe, expect, it, vi } from "vitest";
import type { AnalysisConfig } from "../config.js";
import {
  AnthropicApiSkillGenerator,
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
});
