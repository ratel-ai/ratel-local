import { describe, expect, it, vi } from "vitest";
import type { AnalysisConfig } from "../config.js";
import {
  checkExtractorHealth,
  chunkTurns,
  createExtractor,
  HttpIntentExtractor,
  NaiveIntentExtractor,
} from "./extractor.js";
import type { ChatTurn } from "./types.js";

const EXTRACT_PATH = "/orbitals/claim-extractor/extract";

const TURNS: ChatTurn[] = [
  { role: "user", content: "Help me add OAuth login to my Next.js app" },
  { role: "assistant", content: "Sure, here is how..." },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The orbitals/sidecar response shape: rows wrapped under `extractions`. */
function extractResponse(extractions: { claims?: unknown[]; intents?: unknown[] }): Response {
  return jsonResponse({
    extractions: { claims: extractions.claims ?? [], intents: extractions.intents ?? [] },
    model: "claim-extractor-pro",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    time_taken: 0.1,
  });
}

describe("HttpIntentExtractor", () => {
  it("POSTs the conversation to the orbitals path and unwraps `extractions`", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse({
        claims: [{ subtype: "capability", content: "The app uses Next.js" }],
        intents: [{ content: "Add OAuth login to a Next.js app" }],
      }),
    );
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://127.0.0.1:8723", model: "claim-extractor-4B" },
      { fetch: fetchMock },
    );

    const result = await extractor.extract(TURNS);

    expect(result.intents).toEqual([{ content: "Add OAuth login to a Next.js app" }]);
    expect(result.claims[0]).toEqual({
      subtype: "capability",
      content: "The app uses Next.js",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:8723${EXTRACT_PATH}`);
    expect(init.method).toBe("POST");
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe("claim-extractor-4B");
    expect(sentBody.conversation).toEqual([
      { role: "user", content: "Help me add OAuth login to my Next.js app" },
      { role: "assistant", content: "Sure, here is how..." },
    ]);
  });

  it("still reads a top-level (unwrapped) response for back-compat", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        claims: [{ subtype: "factoid", content: "fact" }],
        intents: [{ content: "do a thing" }],
      }),
    );
    const extractor = new HttpIntentExtractor({ endpoint: "http://x" }, { fetch: fetchMock });
    const result = await extractor.extract(TURNS);
    expect(result.intents).toEqual([{ content: "do a thing" }]);
    expect(result.claims).toEqual([{ subtype: "factoid", content: "fact" }]);
  });

  it("normalizes Title-case subtypes from the hosted endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse({
        claims: [
          { subtype: "Factoid", content: "a" },
          { subtype: "User Assertion", content: "b" },
        ],
      }),
    );
    const extractor = new HttpIntentExtractor({ endpoint: "http://x" }, { fetch: fetchMock });
    const result = await extractor.extract(TURNS);
    expect(result.claims).toEqual([
      { subtype: "factoid", content: "a" },
      { subtype: "user_assertion", content: "b" },
    ]);
  });

  it("trims a trailing slash on the endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(extractResponse({}));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://127.0.0.1:8723/" },
      { fetch: fetchMock },
    );
    await extractor.extract(TURNS);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://127.0.0.1:8723${EXTRACT_PATH}`);
  });

  it("sends a bearer header when an apiKey is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(extractResponse({}));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://remote/api", apiKey: "sk-secret" },
      { fetch: fetchMock },
    );
    await extractor.extract(TURNS);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBe("Bearer sk-secret");
  });

  it("sends a basic header (base64 username:password) for basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(extractResponse({}));
    const extractor = new HttpIntentExtractor(
      {
        endpoint: "https://extractor.example/api",
        authScheme: "basic",
        username: "alice",
        apiKey: "s3cret",
      },
      { fetch: fetchMock },
    );
    await extractor.extract(TURNS);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    // alice:s3cret → YWxpY2U6czNjcmV0
    expect(headers.get("Authorization")).toBe("Basic YWxpY2U6czNjcmV0");
  });

  it("sends no auth header for a bare local sidecar", async () => {
    const fetchMock = vi.fn().mockResolvedValue(extractResponse({}));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://127.0.0.1:8723" },
      { fetch: fetchMock },
    );
    await extractor.extract(TURNS);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get("Authorization")).toBeNull();
  });

  it("drops malformed claims/intents instead of throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      extractResponse({
        claims: [{ subtype: "bogus", content: "x" }, { content: "no subtype" }, 42],
        intents: [{ content: "valid" }, { nope: true }, "string-intent"],
      }),
    );
    const extractor = new HttpIntentExtractor({ endpoint: "http://x" }, { fetch: fetchMock });
    const result = await extractor.extract(TURNS);
    expect(result.claims).toEqual([]);
    expect(result.intents).toEqual([{ content: "valid" }]);
  });

  it("throws immediately on a 4xx without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad input", { status: 422 }));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://x" },
      { fetch: fetchMock, sleep: () => Promise.resolve() },
    );
    await expect(extractor.extract(TURNS)).rejects.toThrow(/422.*bad input/);
    // A client error won't fix itself, so we don't burn retries on it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 5xx and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("flaky", { status: 500 }))
      .mockResolvedValueOnce(extractResponse({ intents: [{ content: "recovered" }] }));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://x" },
      { fetch: fetchMock, sleep: () => Promise.resolve() },
    );
    const result = await extractor.extract(TURNS);
    expect(result.intents).toEqual([{ content: "recovered" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget on a persistent 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://x" },
      { fetch: fetchMock, sleep: () => Promise.resolve() },
    );
    await expect(extractor.extract(TURNS)).rejects.toThrow(/503/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a timeout (bounds total run time)", async () => {
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://x" },
      { fetch: fetchMock, sleep: () => Promise.resolve() },
    );
    await expect(extractor.extract(TURNS)).rejects.toThrow(/timed out/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("splits a conversation over the budget into chunks and merges the results", async () => {
    // Two requests' worth of turns: a tiny budget forces one turn per chunk.
    const turns: ChatTurn[] = [
      { role: "user", content: "first request about caching" },
      { role: "user", content: "second request about auth" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        extractResponse({
          claims: [{ subtype: "factoid", content: "shared" }],
          intents: [{ content: "cache things" }],
        }),
      )
      .mockResolvedValueOnce(
        extractResponse({
          // "shared" claim repeats across chunks and must be de-duplicated.
          claims: [{ subtype: "factoid", content: "shared" }],
          intents: [{ content: "auth things" }],
        }),
      );
    const extractor = new HttpIntentExtractor(
      { endpoint: "http://x", maxRequestChars: 1 },
      { fetch: fetchMock, sleep: () => Promise.resolve() },
    );
    const result = await extractor.extract(turns);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.intents).toEqual([{ content: "cache things" }, { content: "auth things" }]);
    expect(result.claims).toEqual([{ subtype: "factoid", content: "shared" }]);
  });

  it("requires an endpoint", () => {
    expect(() => new HttpIntentExtractor({})).toThrow(/endpoint/i);
  });
});

describe("chunkTurns", () => {
  const t = (content: string): ChatTurn => ({ role: "user", content });

  it("keeps a small conversation as a single chunk", () => {
    const turns = [t("a"), t("b"), t("c")];
    expect(chunkTurns(turns, 10_000)).toEqual([turns]);
  });

  it("splits when the running size would exceed the budget", () => {
    // Each turn serializes to ~30+ chars; a 60-char budget fits about two per chunk.
    const turns = [t("one"), t("two"), t("three"), t("four")];
    const chunks = chunkTurns(turns, 70);
    expect(chunks.length).toBeGreaterThan(1);
    // No turn is dropped and order is preserved.
    expect(chunks.flat()).toEqual(turns);
  });

  it("never splits a single oversized turn — it gets its own chunk", () => {
    const turns = [t("x".repeat(5000)), t("small")];
    const chunks = chunkTurns(turns, 100);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual([turns[0]]);
    expect(chunks[1]).toEqual([turns[1]]);
  });

  it("returns no chunks for an empty conversation", () => {
    expect(chunkTurns([], 100)).toEqual([]);
  });
});

describe("checkExtractorHealth", () => {
  it("GETs /health with the configured auth and reports ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    const health = await checkExtractorHealth(
      {
        endpoint: "https://extractor.example/api/",
        authScheme: "basic",
        username: "alice",
        apiKey: "s3cret",
      },
      { fetch: fetchMock },
    );
    expect(health).toEqual({ ok: true, status: 200, detail: "ok" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://extractor.example/api/health");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Basic YWxpY2U6czNjcmV0");
  });

  it("reports a credentials hint on 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const health = await checkExtractorHealth({ endpoint: "http://x" }, { fetch: fetchMock });
    expect(health.ok).toBe(false);
    expect(health.status).toBe(401);
    expect(health.detail).toMatch(/credentials/i);
  });

  it("never throws on a network error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const health = await checkExtractorHealth({ endpoint: "http://nope" }, { fetch: fetchMock });
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/ECONNREFUSED/);
  });

  it("returns a clear message when no endpoint is set", async () => {
    const health = await checkExtractorHealth({});
    expect(health).toEqual({ ok: false, detail: "No endpoint configured" });
  });
});

describe("NaiveIntentExtractor", () => {
  it("derives one intent per user turn and emits no claims", async () => {
    const result = await new NaiveIntentExtractor().extract([
      { role: "user", content: "Add OAuth login to my app" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Now write tests for it" },
    ]);
    expect(result.claims).toEqual([]);
    expect(result.intents.map((i) => i.content)).toEqual([
      "Add OAuth login to my app",
      "Now write tests for it",
    ]);
  });

  it("ignores empty user turns", async () => {
    const result = await new NaiveIntentExtractor().extract([
      { role: "user", content: "   " },
      { role: "user", content: "real intent" },
    ]);
    expect(result.intents.map((i) => i.content)).toEqual(["real intent"]);
  });
});

describe("createExtractor", () => {
  it("builds an HttpIntentExtractor for provider http", () => {
    const cfg: AnalysisConfig = { extractor: { provider: "http", endpoint: "http://x" } };
    expect(createExtractor(cfg)).toBeInstanceOf(HttpIntentExtractor);
  });

  it("builds an HttpIntentExtractor for provider cloud", () => {
    const cfg: AnalysisConfig = {
      extractor: { provider: "cloud", endpoint: "http://cloud", apiKey: "k" },
    };
    expect(createExtractor(cfg)).toBeInstanceOf(HttpIntentExtractor);
  });

  it("builds a NaiveIntentExtractor for provider naive", () => {
    const cfg: AnalysisConfig = { extractor: { provider: "naive" } };
    expect(createExtractor(cfg)).toBeInstanceOf(NaiveIntentExtractor);
  });

  it("defaults to http when an endpoint is set but no provider", () => {
    const cfg: AnalysisConfig = { extractor: { endpoint: "http://x" } };
    expect(createExtractor(cfg)).toBeInstanceOf(HttpIntentExtractor);
  });

  it("falls back to naive when no endpoint and no provider", () => {
    expect(createExtractor({})).toBeInstanceOf(NaiveIntentExtractor);
  });
});
