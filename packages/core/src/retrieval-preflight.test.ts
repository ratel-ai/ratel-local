import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { downloadFileToCacheDir, pathsInfo } from "@huggingface/hub";
import { describe, expect, it, vi } from "vitest";
import {
  downloadHuggingFaceRetrievalModel,
  inspectRetrievalPreparation,
  preflightRetrieval,
} from "./retrieval-preflight.js";

describe("retrieval preflight", () => {
  it("distinguishes a cached built-in model from a required download", async () => {
    const cached = vi.fn().mockResolvedValue(true);
    const missing = vi.fn().mockResolvedValue(false);

    await expect(
      inspectRetrievalPreparation(
        { method: "hybrid" },
        { homeDir: "/home/u", env: {}, isModelCached: cached },
      ),
    ).resolves.toMatchObject({
      action: "verify",
      source: "built-in",
      model: "BAAI/bge-small-en-v1.5",
    });
    await expect(
      inspectRetrievalPreparation(
        { method: "hybrid" },
        { homeDir: "/home/u", env: {}, isModelCached: missing },
      ),
    ).resolves.toMatchObject({
      action: "download-and-verify",
      source: "built-in",
      model: "BAAI/bge-small-en-v1.5",
    });
    expect(cached).toHaveBeenCalledWith(
      "BAAI/bge-small-en-v1.5",
      "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
    );
  });

  it("does not treat a partial Hugging Face snapshot as a cached model", async () => {
    const root = await mkdtemp(join(tmpdir(), "ratel-retrieval-cache-"));
    const snapshot = join(
      root,
      "models--BAAI--bge-small-en-v1.5",
      "snapshots",
      "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
    );
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "config.json"), "{}");
    try {
      await expect(
        inspectRetrievalPreparation(
          { method: "semantic" },
          { homeDir: "/home/u", env: { HF_HUB_CACHE: root } },
        ),
      ).resolves.toMatchObject({ action: "download-and-verify" });

      await writeFile(join(snapshot, "tokenizer.json"), "{}");
      await writeFile(join(snapshot, "model.safetensors"), "model");
      await expect(
        inspectRetrievalPreparation(
          { method: "semantic" },
          { homeDir: "/home/u", env: { HF_HUB_CACHE: root } },
        ),
      ).resolves.toMatchObject({ action: "verify" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only checks the Hugging Face cache for downloadable model sources", async () => {
    const isModelCached = vi.fn().mockResolvedValue(false);

    await expect(
      inspectRetrievalPreparation(
        { method: "semantic", embedding: { local: "/models/bge" } },
        { homeDir: "/home/u", env: {}, isModelCached },
      ),
    ).resolves.toMatchObject({
      action: "verify",
      source: "local",
    });
    expect(isModelCached).not.toHaveBeenCalled();
  });

  it("reports that BM25 needs neither download nor verification", async () => {
    const isModelCached = vi.fn();

    await expect(
      inspectRetrievalPreparation(
        { method: "bm25" },
        { homeDir: "/home/u", env: {}, isModelCached },
      ),
    ).resolves.toMatchObject({
      action: "none",
      source: "none",
    });
    expect(isModelCached).not.toHaveBeenCalled();
  });

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

  it("reports real model download bytes before verifying the dense probe", async () => {
    const events: unknown[] = [];
    const order: string[] = [];
    const probe = vi.fn(async () => {
      order.push("probe");
    });
    const prepareHuggingFaceModel = vi.fn(async (_model, options) => {
      order.push("download");
      options.onProgress({
        phase: "downloading",
        file: "model.safetensors",
        loadedBytes: 50,
        totalBytes: 100,
        percent: 50,
      });
      return { totalBytes: 100 };
    });

    await preflightRetrieval(
      { method: "semantic" },
      {
        homeDir: "/home/u",
        env: {},
        probe,
        onProgress: (event) => events.push(event),
        isModelCached: async () => false,
        prepareHuggingFaceModel,
      },
    );

    expect(prepareHuggingFaceModel).toHaveBeenCalledWith(
      "BAAI/bge-small-en-v1.5",
      expect.objectContaining({
        homeDir: "/home/u",
        revision: "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a",
      }),
    );
    expect(events).toEqual([
      {
        phase: "downloading",
        file: "model.safetensors",
        loadedBytes: 50,
        totalBytes: 100,
        percent: 50,
      },
      {
        phase: "verifying",
        loadedBytes: 100,
        totalBytes: 100,
        percent: 100,
      },
    ]);
    expect(order).toEqual(["download", "probe"]);
  });

  it("derives download progress from streamed response bytes", async () => {
    const sizes: Record<string, number> = {
      "config.json": 10,
      "tokenizer.json": 20,
      "model.safetensors": 60,
      "pytorch_model.bin": 200,
      "1_Pooling/config.json": 10,
    };
    const getPathsInfo = vi.fn(async () =>
      Object.entries(sizes).map(([path, size]) => ({
        path,
        size,
        type: "file",
        oid: `oid-${path}`,
        lastCommit: { id: "a".repeat(40), title: "test", date: new Date(0) },
        securityFileStatus: { status: "safe" },
      })),
    ) as unknown as typeof pathsInfo;
    const baseFetch = vi.fn(async (input: string | URL | Request) => {
      const path = decodeURIComponent(new URL(input.toString()).pathname.split("/").at(-1) ?? "");
      const size = sizes[path] ?? 0;
      const midpoint = Math.floor(size / 2);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(midpoint));
            controller.enqueue(new Uint8Array(size - midpoint));
            controller.close();
          },
        }),
        { status: 206, headers: { "Content-Range": `bytes 0-${size - 1}/${size}` } },
      );
    });
    const cacheFile = vi.fn(async (params: Parameters<typeof downloadFileToCacheDir>[0]) => {
      const response = await params.fetch?.(
        new URL(`https://cdn.example.test/${encodeURIComponent(params.path)}`),
        { method: "GET" },
      );
      await response?.arrayBuffer();
      return `/cache/${params.path}`;
    }) as typeof downloadFileToCacheDir;
    const events: Array<{ loadedBytes: number; totalBytes: number; percent: number }> = [];

    await downloadHuggingFaceRetrievalModel(
      "BAAI/bge-small-en-v1.5",
      {
        homeDir: "/home/u",
        env: {},
        onProgress: (event) => events.push(event),
      },
      { pathsInfo: getPathsInfo, downloadFileToCacheDir: cacheFile, fetch: baseFetch },
    );

    expect(events.at(-1)).toMatchObject({ loadedBytes: 100, totalBytes: 100, percent: 100 });
    expect(events.some((event) => event.loadedBytes > 0 && event.loadedBytes < 100)).toBe(true);
    expect(cacheFile).toHaveBeenCalledTimes(4);
    expect(cacheFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "pytorch_model.bin" }),
    );
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
