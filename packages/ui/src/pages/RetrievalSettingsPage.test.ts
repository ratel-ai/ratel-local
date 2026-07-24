import { describe, expect, it } from "vitest";
import {
  availableRetrievalScopes,
  retrievalConfigFromDraft,
  retrievalDraftKey,
  retrievalDraftFromConfig,
  retrievalTarget,
} from "./RetrievalSettingsPage";

describe("retrieval settings model", () => {
  it("maps the inherited BM25 default to a model-free draft", () => {
    expect(retrievalDraftFromConfig(undefined)).toEqual({
      method: "bm25",
      source: "built-in",
      model: "",
      url: "",
      apiKeyEnv: "",
      revision: "",
      download: false,
      queryPrefix: "",
      docPrefix: "",
      pooling: "",
    });
    expect(retrievalConfigFromDraft(retrievalDraftFromConfig(undefined))).toEqual({
      method: "bm25",
    });
  });

  it.each([
    {
      config: { method: "semantic", embedding: undefined },
      source: "built-in",
    },
    {
      config: {
        method: "hybrid",
        embedding: { huggingface: "intfloat/e5-small-v2", download: true },
      },
      source: "huggingface",
    },
    {
      config: { method: "semantic", embedding: { local: "/models/bge" } },
      source: "local",
    },
    {
      config: { method: "semantic", embedding: { ollama: "nomic-embed-text" } },
      source: "ollama",
    },
    {
      config: {
        method: "hybrid",
        embedding: {
          url: "https://embed.example.test/v1/embeddings",
          model: "text-embedding-3-small",
          apiKeyEnv: "EMBEDDING_API_KEY",
        },
      },
      source: "endpoint",
    },
  ] as const)("round-trips the $source source progressively", ({ config, source }) => {
    const draft = retrievalDraftFromConfig(config);
    expect(draft.source).toBe(source);
    expect(retrievalConfigFromDraft(draft)).toEqual(config);
  });

  it("rejects endpoint drafts that omit URL or model", () => {
    const draft = retrievalDraftFromConfig({
      method: "semantic",
      embedding: {
        url: "https://embed.example.test/v1/embeddings",
        model: "text-embedding-3-small",
      },
    });
    expect(() => retrievalConfigFromDraft({ ...draft, url: "" })).toThrow(/URL is required/);
    expect(() => retrievalConfigFromDraft({ ...draft, model: "" })).toThrow(/model is required/);
  });

  it.each([
    ["method", "hybrid"],
    ["source", "endpoint"],
    ["model", "other-model"],
    ["url", "https://other.example.test/v1/embeddings"],
    ["apiKeyEnv", "OTHER_KEY"],
    ["revision", "v2"],
    ["download", true],
    ["queryPrefix", "query: "],
    ["docPrefix", "passage: "],
    ["pooling", "mean"],
  ] as const)("changes the preflight identity when %s changes", (field, value) => {
    const draft = retrievalDraftFromConfig({
      method: "semantic",
      embedding: { ollama: "nomic-embed-text" },
    });

    expect(retrievalDraftKey({ ...draft, [field]: value })).not.toBe(retrievalDraftKey(draft));
  });

  it("allows all scopes only inside a project runtime context", () => {
    expect(availableRetrievalScopes({ kind: "global" })).toEqual(["user"]);
    expect(availableRetrievalScopes({ kind: "project", projectId: "project/a" })).toEqual([
      "user",
      "project",
      "local",
    ]);
    expect(retrievalTarget("user", { kind: "global" })).toEqual({ scope: "user" });
    expect(retrievalTarget("local", { kind: "project", projectId: "project/a" })).toEqual({
      scope: "local",
      projectId: "project/a",
    });
  });
});
