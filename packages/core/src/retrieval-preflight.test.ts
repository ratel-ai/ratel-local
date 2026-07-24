import { describe, expect, it, vi } from "vitest";
import { preflightRetrieval } from "./retrieval-preflight.js";

describe("retrieval preflight", () => {
  it("keeps BM25 model-free and does not invoke the dense probe", async () => {
    const probe = vi.fn();

    await expect(
      preflightRetrieval({ method: "bm25" }, { homeDir: "/home/u", env: {}, probe }),
    ).resolves.toMatchObject({
      status: "not-required",
      method: "bm25",
      source: "none",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("prepares the pinned built-in model and reports its runtime disclosures", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    const result = await preflightRetrieval(
      { method: "semantic" },
      { homeDir: "/home/u", env: {}, probe },
    );

    expect(probe).toHaveBeenCalledWith({
      method: "semantic",
      embedding: undefined,
    });
    expect(result).toMatchObject({
      status: "ready",
      method: "semantic",
      source: "built-in",
      model: "BAAI/bge-small-en-v1.5",
      runtimeMemoryMb: 130,
      remoteDataTransfer: false,
    });
  });

  it("opts Hugging Face preparation into download without changing persisted config", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const retrieval = {
      method: "hybrid" as const,
      embedding: {
        huggingface: "intfloat/multilingual-e5-small",
        revision: "main",
        download: false,
      },
    };

    const result = await preflightRetrieval(retrieval, {
      homeDir: "/home/u",
      env: {},
      probe,
    });

    expect(probe).toHaveBeenCalledWith({
      method: "hybrid",
      embedding: {
        huggingface: "intfloat/multilingual-e5-small",
        revision: "main",
        download: true,
      },
    });
    expect(retrieval.embedding.download).toBe(false);
    expect(result).toMatchObject({
      status: "ready",
      source: "huggingface",
      model: "intfloat/multilingual-e5-small",
      downloadedIfMissing: true,
    });
  });

  it("expands tilde local paths before checking the model", async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    await preflightRetrieval(
      {
        method: "semantic",
        embedding: { local: "~/.cache/models/bge" },
      },
      { homeDir: "/home/u", env: {}, probe },
    );

    expect(probe).toHaveBeenCalledWith({
      method: "semantic",
      embedding: { local: "/home/u/.cache/models/bge" },
    });
  });

  it("fails before a remote request when apiKeyEnv is not available", async () => {
    const probe = vi.fn();

    await expect(
      preflightRetrieval(
        {
          method: "semantic",
          embedding: {
            url: "https://embeddings.example.test/v1/embeddings",
            model: "text-embedding-3-small",
            apiKeyEnv: "EMBEDDING_API_KEY",
          },
        },
        { homeDir: "/home/u", env: {}, probe },
      ),
    ).rejects.toMatchObject({
      code: "RETRIEVAL_PREFLIGHT_FAILED",
      reason: "missing_api_key_env",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each([
    {
      embedding: { ollama: "nomic-embed-text" },
      source: "ollama",
      model: "nomic-embed-text",
      remoteDataTransfer: false,
    },
    {
      embedding: {
        url: "http://127.0.0.1:8080/v1/embeddings",
        model: "bge-small",
      },
      source: "endpoint",
      model: "bge-small",
      remoteDataTransfer: true,
    },
  ] as const)("checks $source availability with a real embedding probe", async (testCase) => {
    const probe = vi.fn().mockResolvedValue(undefined);

    const result = await preflightRetrieval(
      { method: "semantic", embedding: testCase.embedding },
      { homeDir: "/home/u", env: {}, probe },
    );

    expect(probe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "ready",
      source: testCase.source,
      model: testCase.model,
      remoteDataTransfer: testCase.remoteDataTransfer,
    });
  });
});
