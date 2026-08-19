import { describe, expect, it } from "vitest";
import { mergeConfigs, parseConfig, type RatelConfig } from "./config.js";

describe("parseConfig", () => {
  it("parses a well-formed multi-server config with stdio and http entries", () => {
    const config = parseConfig({
      mcpServers: {
        fs: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          env: { FOO: "bar" },
          cwd: "/tmp",
        },
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer xyz" },
        },
      },
    });

    expect(config.mcpServers.fs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    });
    expect(config.mcpServers.remote).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer xyz" },
    });
  });

  it("defaults type to stdio when omitted", () => {
    const config = parseConfig({
      mcpServers: { fs: { command: "echo", args: ["hi"] } },
    });
    expect(config.mcpServers.fs.type).toBe("stdio");
  });

  it("rejects a non-object root", () => {
    expect(() => parseConfig(null)).toThrow(/root.*object/i);
    expect(() => parseConfig("not a config")).toThrow(/root.*object/i);
  });

  it("accepts a skills-only document by defaulting mcpServers to an empty object", () => {
    expect(parseConfig({ skills: { dirs: [] } })).toEqual({
      mcpServers: {},
      skills: { dirs: [] },
    });
  });

  it("rejects when mcpServers is present but not an object", () => {
    expect(() => parseConfig({ mcpServers: "nope" })).toThrow(/mcpServers/);
  });

  it("rejects a stdio entry without a string command, surfacing the field path", () => {
    expect(() => parseConfig({ mcpServers: { fs: { type: "stdio" } } })).toThrow(
      /mcpServers\.fs\.command/,
    );
    expect(() => parseConfig({ mcpServers: { fs: { type: "stdio", command: 42 } } })).toThrow(
      /mcpServers\.fs\.command/,
    );
  });

  it("rejects an http entry without a string url, surfacing the field path", () => {
    expect(() => parseConfig({ mcpServers: { remote: { type: "http" } } })).toThrow(
      /mcpServers\.remote\.url/,
    );
  });

  it("rejects malformed args / env without losing the field path", () => {
    expect(() =>
      parseConfig({
        mcpServers: { fs: { command: "echo", args: "should be array" } },
      }),
    ).toThrow(/mcpServers\.fs\.args/);
    expect(() =>
      parseConfig({
        mcpServers: { fs: { command: "echo", env: { FOO: 42 } } },
      }),
    ).toThrow(/mcpServers\.fs\.env\.FOO/);
  });

  it("tolerates unknown transport types (kept verbatim for runtime to skip)", () => {
    const config = parseConfig({
      mcpServers: {
        legacy: { type: "sse", url: "https://x" },
        future: { type: "websocket", url: "ws://x" },
      },
    });
    expect(config.mcpServers.legacy.type).toBe("sse");
    expect(config.mcpServers.future.type).toBe("websocket");
  });

  it("preserves a string description on stdio, http, and unknown-type entries", () => {
    const config = parseConfig({
      mcpServers: {
        fs: {
          type: "stdio",
          command: "echo",
          description: "echo for tests",
        },
        remote: {
          type: "http",
          url: "https://x",
          description: "remote api",
        },
        legacy: {
          type: "sse",
          url: "https://y",
          description: "legacy sse",
        },
      },
    });
    expect(config.mcpServers.fs.description).toBe("echo for tests");
    expect(config.mcpServers.remote.description).toBe("remote api");
    expect(config.mcpServers.legacy.description).toBe("legacy sse");
  });

  it("rejects a non-string description, surfacing the field path", () => {
    expect(() =>
      parseConfig({
        mcpServers: { fs: { command: "echo", description: 42 } },
      }),
    ).toThrow(/mcpServers\.fs\.description/);
    expect(() =>
      parseConfig({
        mcpServers: { remote: { type: "http", url: "https://x", description: { wat: 1 } } },
      }),
    ).toThrow(/mcpServers\.remote\.description/);
  });

  it("tolerates unknown per-entry fields for forward compatibility", () => {
    const config = parseConfig({
      mcpServers: {
        fs: {
          command: "echo",
          alwaysLoad: true,
          headersHelper: "/path/to/script",
        },
      },
    });
    expect(config.mcpServers.fs.command).toBe("echo");
    // Unknown fields are tolerated; we don't promise to surface them.
  });

  it("preserves OAuth fields on http and sse entries", () => {
    const config = parseConfig({
      mcpServers: {
        remote: {
          type: "http",
          url: "https://x/mcp",
          clientId: "abc123",
          clientSecret: "shh",
          callbackPort: 12345,
          scope: "read write",
        },
        legacy: {
          type: "sse",
          url: "https://y/mcp",
          clientId: "zzz",
          callbackPort: 9999,
        },
      },
    });
    expect(config.mcpServers.remote).toEqual({
      type: "http",
      url: "https://x/mcp",
      clientId: "abc123",
      clientSecret: "shh",
      callbackPort: 12345,
      scope: "read write",
    });
    expect(config.mcpServers.legacy).toEqual({
      type: "sse",
      url: "https://y/mcp",
      clientId: "zzz",
      callbackPort: 9999,
    });
  });

  it("rejects OAuth fields on stdio entries", () => {
    expect(() => parseConfig({ mcpServers: { fs: { command: "echo", clientId: "abc" } } })).toThrow(
      /mcpServers\.fs\.clientId/,
    );
    expect(() =>
      parseConfig({ mcpServers: { fs: { command: "echo", callbackPort: 1234 } } }),
    ).toThrow(/mcpServers\.fs\.callbackPort/);
  });

  it("rejects malformed OAuth fields on http entries", () => {
    expect(() =>
      parseConfig({
        mcpServers: { r: { type: "http", url: "https://x", clientId: 42 } },
      }),
    ).toThrow(/mcpServers\.r\.clientId.*string/);
    expect(() =>
      parseConfig({
        mcpServers: { r: { type: "http", url: "https://x", callbackPort: "1234" } },
      }),
    ).toThrow(/mcpServers\.r\.callbackPort.*(number|integer)/);
    expect(() =>
      parseConfig({
        mcpServers: { r: { type: "http", url: "https://x", callbackPort: 1.5 } },
      }),
    ).toThrow(/mcpServers\.r\.callbackPort.*integer/);
    expect(() =>
      parseConfig({
        mcpServers: { r: { type: "http", url: "https://x", callbackPort: -1 } },
      }),
    ).toThrow(/mcpServers\.r\.callbackPort/);
    expect(() =>
      parseConfig({
        mcpServers: { r: { type: "http", url: "https://x", scope: 42 } },
      }),
    ).toThrow(/mcpServers\.r\.scope.*string/);
  });
});

describe("mergeConfigs", () => {
  const a: RatelConfig = {
    mcpServers: {
      fs: { type: "stdio", command: "echo", args: ["a"] },
      remote: { type: "http", url: "https://a" },
    },
  };
  const b: RatelConfig = {
    mcpServers: {
      fs: { type: "stdio", command: "echo", args: ["b"] },
      extra: { type: "stdio", command: "ls" },
    },
  };

  it("returns an empty config for an empty list", () => {
    expect(mergeConfigs([])).toEqual({ mcpServers: {} });
  });

  it("returns a clone of the single input when given one config", () => {
    const merged = mergeConfigs([a]);
    expect(merged).toEqual(a);
    expect(merged).not.toBe(a);
    expect(merged.mcpServers).not.toBe(a.mcpServers);
  });

  it("uses right-most precedence on duplicate keys", () => {
    const merged = mergeConfigs([a, b]);
    expect(merged.mcpServers.fs).toEqual({ type: "stdio", command: "echo", args: ["b"] });
  });

  it("preserves keys unique to each config", () => {
    const merged = mergeConfigs([a, b]);
    expect(merged.mcpServers.remote).toEqual({ type: "http", url: "https://a" });
    expect(merged.mcpServers.extra).toEqual({ type: "stdio", command: "ls" });
  });

  it("does not mutate any input config", () => {
    const aFrozen = Object.freeze({
      mcpServers: Object.freeze({ ...a.mcpServers }),
    }) as RatelConfig;
    const bFrozen = Object.freeze({
      mcpServers: Object.freeze({ ...b.mcpServers }),
    }) as RatelConfig;
    expect(() => mergeConfigs([aFrozen, bFrozen])).not.toThrow();
    expect(Object.keys(aFrozen.mcpServers)).toEqual(["fs", "remote"]);
    expect(Object.keys(bFrozen.mcpServers)).toEqual(["fs", "extra"]);
  });
});

describe("parseConfig retrieval", () => {
  it.each(["bm25", "semantic", "hybrid"] as const)("accepts the %s retrieval method", (method) => {
    expect(parseConfig({ retrieval: { method } }).retrieval).toEqual({ method });
  });

  it("accepts every supported explicit embedding source", () => {
    const embeddings = [
      "/opt/models/bge",
      "~/models/bge",
      {
        huggingface: "intfloat/e5-small-v2",
        revision: "v1",
        queryPrefix: "query: ",
        docPrefix: "passage: ",
        pooling: "mean",
        download: false,
      },
      { local: "/opt/models/bge", pooling: "cls" },
      { ollama: "nomic-embed-text", queryPrefix: "search_query: " },
      {
        url: "https://embeddings.example/v1/embeddings",
        model: "text-embedding-3-small",
        apiKeyEnv: "EMBEDDING_API_KEY",
      },
    ];

    for (const embedding of embeddings) {
      expect(parseConfig({ retrieval: { method: "semantic", embedding } }).retrieval).toEqual({
        method: "semantic",
        embedding,
      });
    }
  });

  it("rejects malformed, unknown, and incomplete retrieval methods", () => {
    expect(() => parseConfig({ retrieval: "semantic" })).toThrow(/retrieval.*object/i);
    expect(() => parseConfig({ retrieval: {} })).toThrow(/retrieval\.method/);
    expect(() => parseConfig({ retrieval: { method: "dense" } })).toThrow(/bm25\|semantic\|hybrid/);
    expect(() => parseConfig({ retrieval: { method: "semantic", fallback: "bm25" } })).toThrow(
      /retrieval\.fallback/,
    );
  });

  it("rejects an embedding when BM25 is selected", () => {
    expect(() =>
      parseConfig({
        retrieval: { method: "bm25", embedding: { ollama: "nomic-embed-text" } },
      }),
    ).toThrow(/inactive.*bm25/i);
  });

  it("rejects relative local paths and mixed embedding sources", () => {
    expect(() =>
      parseConfig({ retrieval: { method: "semantic", embedding: "./models/bge" } }),
    ).toThrow(/absolute path/);
    expect(() =>
      parseConfig({
        retrieval: {
          method: "semantic",
          embedding: { local: "models/bge" },
        },
      }),
    ).toThrow(/absolute path/);
    expect(() =>
      parseConfig({
        retrieval: {
          method: "hybrid",
          embedding: { huggingface: "model/repo", ollama: "model" },
        },
      }),
    ).toThrow(/exactly one source/);
  });

  it("rejects literal endpoint credentials and invalid apiKeyEnv names", () => {
    expect(() =>
      parseConfig({
        retrieval: {
          method: "semantic",
          embedding: {
            url: "https://secret:literal@example.com/v1/embeddings",
            model: "embed",
          },
        },
      }),
    ).toThrow(/credentials/);
    expect(() =>
      parseConfig({
        retrieval: {
          method: "semantic",
          embedding: {
            url: "https://example.com/v1/embeddings",
            model: "embed",
            apiKey: "literal-secret",
          },
        },
      }),
    ).toThrow(/apiKeyEnv/);
    expect(() =>
      parseConfig({
        retrieval: {
          method: "semantic",
          embedding: {
            url: "https://example.com/v1/embeddings",
            model: "embed",
            apiKeyEnv: "NOT-AN-ENV-NAME",
          },
        },
      }),
    ).toThrow(/environment variable name/);
  });

  it("rejects obvious credential query parameters but permits endpoint options", () => {
    for (const parameter of ["api_key", "access-token", "authorization", "client_secret"]) {
      expect(() =>
        parseConfig({
          retrieval: {
            method: "semantic",
            embedding: {
              url: `https://example.com/v1/embeddings?${parameter}=literal-secret`,
              model: "embed",
            },
          },
        }),
      ).toThrow(/credential query parameter.*apiKeyEnv/);
    }

    expect(
      parseConfig({
        retrieval: {
          method: "semantic",
          embedding: {
            url: "https://example.com/v1/embeddings?api-version=2024-02-01",
            model: "embed",
          },
        },
      }).retrieval,
    ).toEqual({
      method: "semantic",
      embedding: {
        url: "https://example.com/v1/embeddings?api-version=2024-02-01",
        model: "embed",
      },
    });
  });
});

describe("mergeConfigs retrieval", () => {
  it("treats each retrieval block atomically and lets the right-most scope win", () => {
    const inherited: RatelConfig = {
      mcpServers: {},
      retrieval: {
        method: "semantic",
        embedding: { huggingface: "intfloat/e5-small-v2", download: false },
      },
    };
    const local: RatelConfig = {
      mcpServers: {},
      retrieval: { method: "hybrid", embedding: { ollama: "nomic-embed-text" } },
    };

    expect(mergeConfigs([inherited, local]).retrieval).toEqual(local.retrieval);
  });

  it("inherits the earlier retrieval block when later scopes omit it", () => {
    const inherited: RatelConfig = {
      mcpServers: {},
      retrieval: { method: "semantic" },
    };
    expect(mergeConfigs([inherited, { mcpServers: {} }]).retrieval).toEqual(inherited.retrieval);
  });
});

describe("parseConfig skills", () => {
  it("parses explicit reference and managed-copy entries", () => {
    const config = parseConfig({
      skills: {
        entries: {
          review: { mode: "reference", path: "../.agents/skills/review", source: "codex" },
          release: {
            mode: "copy",
            source: "claude",
            copiedFrom: { source: "claude", id: "release" },
          },
        },
      },
    });

    expect(config.skills?.entries).toEqual({
      review: { mode: "reference", path: "../.agents/skills/review", source: "codex" },
      release: {
        mode: "copy",
        source: "claude",
        copiedFrom: { source: "claude", id: "release" },
      },
    });
  });

  it("parses an optional skills.dirs array", () => {
    const config = parseConfig({
      mcpServers: {},
      skills: { dirs: ["~/.ratel/skills", "/abs/skills"] },
    });
    expect(config.skills?.dirs).toEqual(["~/.ratel/skills", "/abs/skills"]);
  });

  it("leaves skills undefined when the block is absent", () => {
    const config = parseConfig({ mcpServers: {} });
    expect(config.skills).toBeUndefined();
  });

  it("rejects a non-object skills block", () => {
    expect(() => parseConfig({ mcpServers: {}, skills: "nope" })).toThrow(/skills.*object/i);
  });

  it("rejects skills.dirs that is not an array of strings", () => {
    expect(() => parseConfig({ mcpServers: {}, skills: { dirs: "x" } })).toThrow(/skills\.dirs/);
    expect(() => parseConfig({ mcpServers: {}, skills: { dirs: [1] } })).toThrow(/skills\.dirs/);
  });
});

describe("mergeConfigs skills", () => {
  it("carries skills through and lets the right-most config win", () => {
    const merged = mergeConfigs([
      { mcpServers: {}, skills: { dirs: ["/one"] } },
      { mcpServers: {}, skills: { dirs: ["/two"] } },
    ]);
    expect(merged.skills?.dirs).toEqual(["/two"]);
  });

  it("preserves an earlier skills block when later configs omit one", () => {
    const merged = mergeConfigs([
      { mcpServers: {}, skills: { dirs: ["/one"] } },
      { mcpServers: {} },
    ]);
    expect(merged.skills?.dirs).toEqual(["/one"]);
  });
});
