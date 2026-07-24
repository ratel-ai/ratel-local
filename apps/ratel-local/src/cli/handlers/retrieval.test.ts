import type {
  BackupFs,
  JsonFs,
  RetrievalConfig,
  RetrievalPreflightResult,
} from "@ratel-ai/ratel-local-core";
import { describe, expect, it, vi } from "vitest";
import { parseArgs } from "../args.js";
import { type CliRetrievalMutator, runRetrieval } from "./retrieval.js";
import type { HandlerCtx } from "./types.js";

const HOME = "/home/u";
const ROOT = "/repo";

class MemFs implements BackupFs, JsonFs {
  files = new Map<string, string>();

  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, contents: string) {
    this.files.set(path, contents);
  }
  async writeAtomic(path: string, contents: string) {
    this.files.set(path, contents);
  }
  async remove(path: string) {
    this.files.delete(path);
  }
  async mkdirp() {}
  async exists(path: string) {
    return this.files.has(path);
  }
  async list() {
    return [];
  }
}

function context(argv: string[], fs = new MemFs()) {
  const log: string[] = [];
  const ctx: HandlerCtx = {
    argv: parseArgs(argv),
    env: { homeDir: HOME, projectRoot: ROOT },
    fs,
    log: (message) => log.push(message),
    prompts: {
      isCancel: () => false,
      text: async () => "",
      select: async () => "",
      confirm: async () => true,
      multiselect: async () => [],
    },
  };
  return { ctx, fs, log };
}

describe("retrieval CLI", () => {
  it("reports each scoped override and the effective rightmost configuration", async () => {
    const { ctx, fs, log } = context(["retrieval", "status"]);
    fs.files.set(
      `${HOME}/.ratel/config.json`,
      JSON.stringify({ retrieval: { method: "semantic" } }),
    );
    fs.files.set(
      `${ROOT}/.ratel/config.json`,
      JSON.stringify({
        retrieval: { method: "hybrid", embedding: { ollama: "nomic-embed-text" } },
      }),
    );

    await runRetrieval(ctx);

    expect(log.join("\n")).toContain("user     semantic  built-in");
    expect(log.join("\n")).toContain("project  hybrid    ollama:nomic-embed-text");
    expect(log.join("\n")).toContain("local    inherited");
    expect(log.join("\n")).toContain("effective hybrid    ollama:nomic-embed-text");
    expect(log.join("\n")).toMatch(/reconnect.*agent\/context/i);
  });

  it("configures an endpoint source through the scoped mutation seam", async () => {
    const { ctx, log } = context([
      "retrieval",
      "configure",
      "--scope",
      "local",
      "--method",
      "hybrid",
      "--source",
      "endpoint",
      "--url",
      "https://embed.example.test/v1/embeddings",
      "--model",
      "text-embedding-3-small",
      "--api-key-env",
      "EMBEDDING_API_KEY",
    ]);
    const mutateRetrieval = vi.fn<CliRetrievalMutator>().mockResolvedValue({
      path: `${ROOT}/.ratel/config.local.json`,
    });

    await runRetrieval(ctx, { mutateRetrieval });

    expect(mutateRetrieval).toHaveBeenCalledWith({
      action: "configure",
      scope: "local",
      retrieval: {
        method: "hybrid",
        embedding: {
          url: "https://embed.example.test/v1/embeddings",
          model: "text-embedding-3-small",
          apiKeyEnv: "EMBEDDING_API_KEY",
        },
      },
    });
    expect(log.join("\n")).toMatch(/reconnect.*agent\/context/i);
  });

  it("rejects inactive embedding flags under BM25", async () => {
    const { ctx } = context([
      "retrieval",
      "configure",
      "--method",
      "bm25",
      "--source",
      "ollama",
      "--model",
      "nomic-embed-text",
    ]);

    await expect(runRetrieval(ctx, { mutateRetrieval: vi.fn() })).rejects.toThrow(
      /BM25.*model-free/i,
    );
  });

  it.each([
    {
      source: "huggingface",
      sourceArgs: ["--model", "intfloat/e5-small-v2"],
      unsupportedArgs: ["--url", "https://embed.example.test/v1/embeddings"],
      flag: "url",
    },
    {
      source: "local",
      sourceArgs: ["--model", "/models/bge"],
      unsupportedArgs: ["--revision", "main"],
      flag: "revision",
    },
    {
      source: "ollama",
      sourceArgs: ["--model", "nomic-embed-text"],
      unsupportedArgs: ["--url", "https://ollama.example.test"],
      flag: "url",
    },
    {
      source: "endpoint",
      sourceArgs: [
        "--model",
        "text-embedding-3-small",
        "--url",
        "https://embed.example.test/v1/embeddings",
      ],
      unsupportedArgs: ["--pooling", "mean"],
      flag: "pooling",
    },
  ])("rejects --$flag for the $source source", async ({ flag, source, sourceArgs, unsupportedArgs }) => {
    const { ctx } = context([
      "retrieval",
      "configure",
      "--method",
      "semantic",
      "--source",
      source,
      ...sourceArgs,
      ...unsupportedArgs,
    ]);

    await expect(runRetrieval(ctx, { mutateRetrieval: vi.fn() })).rejects.toThrow(
      `--${flag} is not valid with --source ${source}`,
    );
  });

  it("resets only the selected scope", async () => {
    const { ctx, log } = context(["retrieval", "reset", "--scope", "project"]);
    const mutateRetrieval = vi.fn<CliRetrievalMutator>().mockResolvedValue({
      path: `${ROOT}/.ratel/config.json`,
    });

    await runRetrieval(ctx, { mutateRetrieval });

    expect(mutateRetrieval).toHaveBeenCalledWith({
      action: "reset",
      scope: "project",
    });
    expect(log.join("\n")).toContain("reset project retrieval override");
  });

  it("prepares the effective model and prints resource and privacy disclosures", async () => {
    const { ctx, fs, log } = context(["retrieval", "prepare"]);
    fs.files.set(
      `${HOME}/.ratel/config.json`,
      JSON.stringify({ retrieval: { method: "semantic" } }),
    );
    const result: RetrievalPreflightResult = {
      status: "ready",
      method: "semantic",
      source: "built-in",
      model: "BAAI/bge-small-en-v1.5",
      downloadedIfMissing: true,
      runtimeMemoryMb: 130,
      remoteDataTransfer: false,
      reconnectRequired: true,
      message: "model ready",
    };
    const preflight = vi.fn().mockResolvedValue(result);

    await runRetrieval(ctx, { preflight });

    expect(preflight).toHaveBeenCalledWith({ method: "semantic" }, { homeDir: HOME });
    expect(log.join("\n")).toContain("model ready");
    expect(log.join("\n")).toContain("~130 MB");
    expect(log.join("\n")).toContain("metadata and queries stay local");
    expect(log.join("\n")).toMatch(/reconnect.*agent\/context/i);
  });

  it("prepares one explicit scope instead of the merged effective value", async () => {
    const { ctx, fs } = context(["retrieval", "prepare", "--scope", "project"]);
    fs.files.set(
      `${HOME}/.ratel/config.json`,
      JSON.stringify({ retrieval: { method: "semantic" } }),
    );
    fs.files.set(
      `${ROOT}/.ratel/config.json`,
      JSON.stringify({
        retrieval: { method: "hybrid", embedding: { ollama: "nomic-embed-text" } },
      }),
    );
    const preflight = vi.fn().mockResolvedValue({
      status: "ready",
      method: "hybrid",
      source: "ollama",
      model: "nomic-embed-text",
      downloadedIfMissing: false,
      runtimeMemoryMb: null,
      remoteDataTransfer: false,
      reconnectRequired: true,
      message: "ollama ready",
    } satisfies RetrievalPreflightResult);

    await runRetrieval(ctx, { preflight });

    expect(preflight).toHaveBeenCalledWith(
      {
        method: "hybrid",
        embedding: { ollama: "nomic-embed-text" },
      } satisfies RetrievalConfig,
      { homeDir: HOME },
    );
  });
});
