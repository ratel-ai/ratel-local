import { describe, expect, it } from "vitest";
import {
  availableRetrievalScopes,
  cloudTraceSettingsPatch,
  retrievalConfigFromDraft,
  retrievalDownloadConfirmationCopy,
  retrievalDraftFromConfig,
  retrievalDraftKey,
  retrievalMethodLabel,
  retrievalNeedsPreparation,
  retrievalProgressLabel,
  retrievalProgressValue,
  retrievalScopeLabel,
  retrievalTarget,
  showsEmbeddingFields,
} from "./RetrievalSettingsPage";

describe("retrieval settings model", () => {
  it("requires an API key only for first-time Cloud setup", () => {
    expect(() =>
      cloudTraceSettingsPatch(
        { configured: false, endpoint: "https://cloud.ratel.sh/api/v1/traces" },
        "",
      ),
    ).toThrow(/API key is required/);
    expect(
      cloudTraceSettingsPatch(
        { configured: false, endpoint: "https://cloud.ratel.sh/api/v1/traces" },
        "rtl_test",
      ),
    ).toEqual({
      endpoint: "https://cloud.ratel.sh/api/v1/traces",
      apiKey: "rtl_test",
    });
    expect(
      cloudTraceSettingsPatch(
        { configured: true, endpoint: "https://cloud.ratel.sh/api/v1/traces" },
        "",
      ),
    ).toEqual({ endpoint: "https://cloud.ratel.sh/api/v1/traces" });
  });

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

  it("shows configurable embedding fields only for explicit dense sources", () => {
    const builtIn = retrievalDraftFromConfig({ method: "semantic" });

    expect(showsEmbeddingFields(builtIn)).toBe(false);
    expect(showsEmbeddingFields({ ...builtIn, source: "huggingface" })).toBe(true);
    expect(showsEmbeddingFields({ ...builtIn, method: "bm25", source: "huggingface" })).toBe(false);
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

  it("uses human-readable labels for retrieval values", () => {
    expect(retrievalMethodLabel("bm25")).toBe("BM25");
    expect(retrievalMethodLabel("semantic")).toBe("Semantic");
    expect(retrievalScopeLabel("user")).toBe("User");
    expect(retrievalScopeLabel("local")).toBe("Local");
  });

  it("only requires preparation for methods that use embeddings", () => {
    expect(retrievalNeedsPreparation(retrievalDraftFromConfig({ method: "bm25" }))).toBe(false);
    expect(retrievalNeedsPreparation(retrievalDraftFromConfig({ method: "semantic" }))).toBe(true);
    expect(retrievalNeedsPreparation(retrievalDraftFromConfig({ method: "hybrid" }))).toBe(true);
  });

  it("uses download-specific confirmation copy only for a missing model", () => {
    expect(
      retrievalDownloadConfirmationCopy({
        action: "download-and-verify",
        method: "hybrid",
        source: "built-in",
        model: "BAAI/bge-small-en-v1.5",
        runtimeMemoryMb: 130,
        remoteDataTransfer: false,
      }),
    ).toEqual({
      title: "Download the built-in model?",
      description:
        "The built-in embedding model is not cached on this machine. Ratel will download it once, verify it, then save these settings.",
    });
  });

  it("uses determinate byte progress while a model is downloading", () => {
    const progress = {
      phase: "downloading" as const,
      file: "model.safetensors",
      loadedBytes: 64,
      totalBytes: 128,
      percent: 50,
    };

    expect(retrievalProgressValue("preparing", progress)).toBe(50);
    expect(retrievalProgressLabel("preparing", progress)).toBe("Downloading model.safetensors…");
    expect(retrievalProgressValue("preparing", { ...progress, phase: "verifying" })).toBe(100);
    expect(retrievalProgressValue("saving", progress)).toBeNull();
  });
});
