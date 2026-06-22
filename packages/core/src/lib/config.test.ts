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

  it("rejects when mcpServers is missing or not an object", () => {
    expect(() => parseConfig({})).toThrow(/mcpServers/);
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

describe("parseConfig skills", () => {
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

describe("parseConfig analysis", () => {
  it("parses a full analysis block", () => {
    const config = parseConfig({
      mcpServers: {},
      analysis: {
        enabled: true,
        chatSource: "hooks",
        extractor: {
          provider: "http",
          endpoint: "http://127.0.0.1:8723",
          apiKey: "sk-secret",
          model: "claim-extractor-4B",
        },
        cadence: { everyNMessages: 10, onIdle: true },
        skillGen: { provider: "auto", apiKey: "sk-anthropic" },
      },
    });
    expect(config.analysis).toEqual({
      enabled: true,
      chatSource: "hooks",
      extractor: {
        provider: "http",
        endpoint: "http://127.0.0.1:8723",
        apiKey: "sk-secret",
        model: "claim-extractor-4B",
      },
      cadence: { everyNMessages: 10, onIdle: true },
      skillGen: { provider: "auto", apiKey: "sk-anthropic" },
    });
  });

  it("leaves analysis undefined when the block is absent", () => {
    const config = parseConfig({ mcpServers: {} });
    expect(config.analysis).toBeUndefined();
  });

  it("accepts a partial analysis block", () => {
    const config = parseConfig({
      mcpServers: {},
      analysis: { cadence: { everyNMessages: 5 } },
    });
    expect(config.analysis).toEqual({ cadence: { everyNMessages: 5 } });
  });

  it("rejects a non-object analysis block", () => {
    expect(() => parseConfig({ mcpServers: {}, analysis: "nope" })).toThrow(/analysis.*object/i);
  });

  it("rejects an unknown chatSource", () => {
    expect(() => parseConfig({ mcpServers: {}, analysis: { chatSource: "telepathy" } })).toThrow(
      /analysis\.chatSource/,
    );
  });

  it("rejects an unknown extractor provider", () => {
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { extractor: { provider: "magic" } } }),
    ).toThrow(/analysis\.extractor\.provider/);
  });

  it("rejects a non-integer everyNMessages", () => {
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { cadence: { everyNMessages: 2.5 } } }),
    ).toThrow(/everyNMessages/);
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { cadence: { everyNMessages: 0 } } }),
    ).toThrow(/everyNMessages/);
  });

  it("parses and round-trips cadence.auto", () => {
    const config = parseConfig({
      mcpServers: {},
      analysis: { cadence: { auto: true, everyNMessages: 5 } },
    });
    expect(config.analysis?.cadence).toEqual({ auto: true, everyNMessages: 5 });
  });

  it("rejects a non-boolean cadence.auto", () => {
    expect(() => parseConfig({ mcpServers: {}, analysis: { cadence: { auto: "yes" } } })).toThrow(
      /analysis\.cadence\.auto/,
    );
  });

  it("parses cadence.recentHours and rejects non-positive values", () => {
    const config = parseConfig({ mcpServers: {}, analysis: { cadence: { recentHours: 5 } } });
    expect(config.analysis?.cadence?.recentHours).toBe(5);
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { cadence: { recentHours: 0 } } }),
    ).toThrow(/analysis\.cadence\.recentHours/);
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { cadence: { recentHours: -1 } } }),
    ).toThrow(/analysis\.cadence\.recentHours/);
  });

  it("rejects a non-boolean enabled", () => {
    expect(() => parseConfig({ mcpServers: {}, analysis: { enabled: "yes" } })).toThrow(
      /analysis\.enabled/,
    );
  });

  it("rejects an unknown skillGen provider", () => {
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { skillGen: { provider: "wizard" } } }),
    ).toThrow(/analysis\.skillGen\.provider/);
  });

  it("parses and round-trips a skillGen model", () => {
    const config = parseConfig({
      mcpServers: {},
      analysis: { skillGen: { provider: "auto", apiKey: "sk-anthropic", model: "haiku" } },
    });
    expect(config.analysis?.skillGen).toEqual({
      provider: "auto",
      apiKey: "sk-anthropic",
      model: "haiku",
    });
  });

  it("rejects a non-string skillGen model", () => {
    expect(() => parseConfig({ mcpServers: {}, analysis: { skillGen: { model: 42 } } })).toThrow(
      /analysis\.skillGen\.model/,
    );
  });

  it("parses a coverage block", () => {
    const config = parseConfig({
      mcpServers: {},
      analysis: { coverage: { minScore: 1.5, relativeRatio: 0.7, maxSkills: 3 } },
    });
    expect(config.analysis?.coverage).toEqual({ minScore: 1.5, relativeRatio: 0.7, maxSkills: 3 });
  });

  it("rejects an out-of-range relativeRatio and a negative minScore", () => {
    expect(() =>
      parseConfig({ mcpServers: {}, analysis: { coverage: { relativeRatio: 1.5 } } }),
    ).toThrow(/relativeRatio/);
    expect(() => parseConfig({ mcpServers: {}, analysis: { coverage: { minScore: -1 } } })).toThrow(
      /minScore/,
    );
    expect(() => parseConfig({ mcpServers: {}, analysis: { coverage: { maxSkills: 0 } } })).toThrow(
      /maxSkills/,
    );
  });
});

describe("mergeConfigs analysis", () => {
  it("carries analysis through and lets the right-most config win", () => {
    const merged = mergeConfigs([
      { mcpServers: {}, analysis: { cadence: { everyNMessages: 5 } } },
      { mcpServers: {}, analysis: { cadence: { everyNMessages: 20 } } },
    ]);
    expect(merged.analysis?.cadence?.everyNMessages).toBe(20);
  });

  it("preserves an earlier analysis block when later configs omit one", () => {
    const merged = mergeConfigs([
      { mcpServers: {}, analysis: { enabled: true } },
      { mcpServers: {} },
    ]);
    expect(merged.analysis?.enabled).toBe(true);
  });
});
