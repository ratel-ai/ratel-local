import { describe, expect, it } from "vitest";
import {
  CloudCatalogAuthError,
  CloudCatalogProtocolError,
  CloudCatalogUnavailableError,
  cloudCatalogEndpoint,
  createCloudCatalogLoader,
  createCloudCatalogSource,
  DEFAULT_CLOUD_CATALOG_ENDPOINT,
} from "./catalog.js";

const ENDPOINT = DEFAULT_CLOUD_CATALOG_ENDPOINT;
const VERSION = "6f7f0cee520a24a6edbb6dc7df6b623751cbdf05771e7e7bbe45cc9de943f0a6";

// Shape taken from a real `GET /api/v1/catalog` against a seeded project; the
// bodies are truncated because the loader treats them as opaque strings.
const WIRE = {
  catalogVersion: VERSION,
  skills: [
    {
      id: "ratel-assessment",
      name: "ratel-assessment",
      description: "Read a partner's agent codebase, score it across the 12-dime",
      tags: [],
      tools: [],
      metadata: {},
      body: "# /ratel-assessment — front-door audit o",
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Records the requests a loader makes so header behaviour can be asserted. */
function recordingFetch(...responses: Array<Response | (() => never)>) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  let index = 0;
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    if (index >= responses.length) throw new Error("no more responses");
    const next = responses[index++];
    if (typeof next === "function") next();
    return next as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const loader = (fetchImpl: typeof fetch) =>
  createCloudCatalogLoader({ endpoint: ENDPOINT, apiKey: "rtl_test", fetch: fetchImpl });

describe("cloudCatalogEndpoint", () => {
  it("requires a secret-free HTTPS URL", () => {
    expect(cloudCatalogEndpoint(ENDPOINT).toString()).toBe(ENDPOINT);
    expect(() => cloudCatalogEndpoint("http://localhost:3000/v1/catalog")).toThrow(/HTTPS/);
    expect(() => cloudCatalogEndpoint("https://user:pw@cloud.ratel.sh/v1/catalog")).toThrow(
      /HTTPS/,
    );
    expect(() => cloudCatalogEndpoint("not a url")).toThrow(/invalid/);
  });
});

describe("createCloudCatalogLoader", () => {
  it("rejects an API key that cannot fit in a header", () => {
    expect(() => createCloudCatalogLoader({ endpoint: ENDPOINT, apiKey: "" })).toThrow(/header/);
    expect(() => createCloudCatalogLoader({ endpoint: ENDPOINT, apiKey: "rtl\nkey" })).toThrow(
      /header/,
    );
  });

  it("pulls the catalog and maps the wire projection onto engine skills", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));
    const { snapshot, degraded } = await loader(impl).load();

    expect(degraded).toBeUndefined();
    expect(snapshot.catalogVersion).toBe(VERSION);
    expect(snapshot.skills).toEqual(WIRE.skills);
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_test");
    expect(calls[0].headers.has("if-none-match")).toBe(false);
  });

  it("revalidates with If-None-Match and reuses the cache on 304", async () => {
    const { calls, impl } = recordingFetch(
      jsonResponse(WIRE),
      new Response(null, { status: 304 }),
      new Response(null, { status: 304 }),
    );
    const client = loader(impl);
    const first = await client.load();
    const second = await client.load();

    expect(calls[1].headers.get("if-none-match")).toBe(`"${VERSION}"`);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.degraded).toBeUndefined();

    first.snapshot.skills.length = 0;
    const third = await client.load();
    expect(third.snapshot.skills).toHaveLength(1);
  });

  it("ignores fields the schema lets a source add", async () => {
    const extra = {
      ...WIRE,
      skills: [{ ...WIRE.skills[0], status: "published", updatedAt: "2026-08-25" }],
    };
    const { snapshot } = await loader(recordingFetch(jsonResponse(extra)).impl).load();
    expect(Object.keys(snapshot.skills[0]).sort()).toEqual([
      "body",
      "description",
      "id",
      "metadata",
      "name",
      "tags",
      "tools",
    ]);
  });

  it("serves a stale snapshot when the source becomes unavailable", async () => {
    const { impl } = recordingFetch(jsonResponse(WIRE), jsonResponse({ error: "nope" }, 503));
    const client = loader(impl);
    await client.load();
    const second = await client.load();

    expect(second.snapshot.catalogVersion).toBe(VERSION);
    expect(second.degraded).toBe("HTTP 503");
  });

  it("fails when the source is unavailable and nothing is cached", async () => {
    const { impl } = recordingFetch(jsonResponse({ error: "nope" }, 503));
    await expect(loader(impl).load()).rejects.toThrow(CloudCatalogUnavailableError);
  });

  it("fails on a network error with nothing cached, and degrades with a cache", async () => {
    const boom = () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(loader(recordingFetch(boom).impl).load()).rejects.toThrow(
      CloudCatalogUnavailableError,
    );

    const client = loader(recordingFetch(jsonResponse(WIRE), boom).impl);
    await client.load();
    expect((await client.load()).degraded).toMatch(/ECONNREFUSED/);
  });

  it("degrades when the body read fails after headers, and errors with nothing cached", async () => {
    const hangingBody = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("socket hang up"));
          },
        }),
        { status: 200 },
      );

    await expect(loader(recordingFetch(hangingBody()).impl).load()).rejects.toThrow(
      CloudCatalogUnavailableError,
    );

    const client = loader(recordingFetch(jsonResponse(WIRE), hangingBody()).impl);
    await client.load();
    const second = await client.load();
    expect(second.snapshot.catalogVersion).toBe(VERSION);
    expect(second.degraded).toMatch(/hang up/);
  });

  it("surfaces an invalid credential even when a snapshot is cached", async () => {
    const { impl } = recordingFetch(jsonResponse(WIRE), jsonResponse({ error: "nope" }, 401));
    const client = loader(impl);
    await client.load();
    // A revoked key must not hide behind the last good catalog.
    await expect(client.load()).rejects.toThrow(CloudCatalogAuthError);
  });

  it("holds a rejected key rather than asking Cloud on every resolve", async () => {
    const { calls, impl } = recordingFetch(
      jsonResponse({ error: "nope" }, 401),
      jsonResponse(WIRE),
    );
    let clock = 0;
    const client = createCloudCatalogLoader({
      endpoint: ENDPOINT,
      apiKey: "rtl_revoked",
      fetch: impl,
      now: () => clock,
    });

    await expect(client.load()).rejects.toThrow(/auth failed: HTTP 401/);
    await expect(client.load()).rejects.toThrow(/auth failed: HTTP 401/);
    expect(calls).toHaveLength(1);

    clock = 60_001;
    await client.load();
    expect(calls).toHaveLength(2);
  });

  it("holds an unreachable Cloud rather than paying its timeout on every resolve", async () => {
    const { calls, impl } = recordingFetch(
      jsonResponse({ error: "gateway" }, 503),
      jsonResponse(WIRE),
    );
    let clock = 0;
    const client = createCloudCatalogLoader({
      endpoint: ENDPOINT,
      apiKey: "rtl_test",
      fetch: impl,
      now: () => clock,
    });

    await expect(client.load()).rejects.toThrow(CloudCatalogUnavailableError);
    await expect(client.load()).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(1);

    clock = 10_001;
    expect((await client.load()).snapshot.catalogVersion).toBe(VERSION);
    expect(calls).toHaveLength(2);
  });

  it("surfaces a contract violation instead of falling back to the cache", async () => {
    const { impl } = recordingFetch(
      jsonResponse(WIRE),
      jsonResponse({ catalogVersion: VERSION, skills: [{ id: "broken" }] }),
    );
    const client = loader(impl);
    await client.load();
    await expect(client.load()).rejects.toThrow(CloudCatalogProtocolError);
  });

  it("rejects a skill missing a required wire field", async () => {
    const { tags: _tags, ...missingTags } = WIRE.skills[0];
    await expect(
      loader(
        recordingFetch(jsonResponse({ catalogVersion: VERSION, skills: [missingTags] })).impl,
      ).load(),
    ).rejects.toThrow(/missing tags/);
  });

  it("rejects malformed payloads", async () => {
    const cases: unknown[] = [
      { skills: [] },
      { catalogVersion: VERSION },
      { catalogVersion: "", skills: [] },
      { catalogVersion: VERSION, skills: [{ ...WIRE.skills[0], tags: "no" }] },
      { catalogVersion: VERSION, skills: [{ ...WIRE.skills[0], metadata: { k: [1] } }] },
    ];
    for (const body of cases) {
      await expect(loader(recordingFetch(jsonResponse(body)).impl).load()).rejects.toThrow(
        CloudCatalogProtocolError,
      );
    }
  });

  it("rejects a catalogVersion that is not header-safe", async () => {
    const badVersion = "v1\r\nX-Injected: 1";
    await expect(
      loader(recordingFetch(jsonResponse({ ...WIRE, catalogVersion: badVersion })).impl).load(),
    ).rejects.toThrow(CloudCatalogProtocolError);

    const goodAgain = { ...WIRE, catalogVersion: `${VERSION}ff` };
    const { impl } = recordingFetch(
      jsonResponse(WIRE),
      jsonResponse({ ...WIRE, catalogVersion: badVersion }),
      jsonResponse(goodAgain),
    );
    const client = loader(impl);
    await client.load();
    await expect(client.load()).rejects.toThrow(CloudCatalogProtocolError);
    const third = await client.load();
    expect(third.snapshot.catalogVersion).toBe(goodAgain.catalogVersion);
    expect(third.degraded).toBeUndefined();
  });

  it("rejects a 304 that arrives before anything is cached", async () => {
    const { impl } = recordingFetch(new Response(null, { status: 304 }));
    await expect(loader(impl).load()).rejects.toThrow(/304 without a cached catalog/);
  });
});

describe("createCloudCatalogSource", () => {
  const source = (
    apiKey: () => Promise<string | undefined>,
    fetchImpl: typeof fetch,
    log: (message: string) => void = () => {},
  ) => createCloudCatalogSource({ apiKey, endpoint: ENDPOINT, log, fetch: fetchImpl });

  it("pulls nothing, and asks Cloud nothing, when no credential is configured", async () => {
    const { calls, impl } = recordingFetch();

    expect(await source(async () => undefined, impl)()).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("keeps one loader across pulls, so the second revalidates instead of re-downloading", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE), new Response(null, { status: 304 }));
    const pull = source(async () => "rtl_one", impl);

    expect((await pull())?.catalog.catalogVersion).toBe(VERSION);
    expect((await pull())?.catalog.catalogVersion).toBe(VERSION);
    expect(calls[1]?.headers.get("If-None-Match")).toBe(`"${VERSION}"`);
  });

  it("picks up a key rotated while the daemon runs", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE), jsonResponse(WIRE));
    let apiKey = "rtl_one";
    const pull = source(async () => apiKey, impl);

    await pull();
    apiKey = "rtl_two";
    await pull();

    expect(calls.map(({ headers }) => headers.get("Authorization"))).toEqual([
      "Bearer rtl_one",
      "Bearer rtl_two",
    ]);
    expect(calls[1]?.headers.get("If-None-Match")).toBeNull();
  });

  it("marks a cached catalog as degraded and says so in the daemon log", async () => {
    const { impl } = recordingFetch(jsonResponse(WIRE), jsonResponse({}, 500));
    const logs: string[] = [];
    const pull = source(
      async () => "rtl_one",
      impl,
      (message) => logs.push(message),
    );

    await pull();
    const stale = await pull();

    expect(stale?.degraded).toBe("HTTP 500");
    expect(stale?.catalog.catalogVersion).toBe(VERSION);
    expect(logs.some((message) => message.includes("HTTP 500"))).toBe(true);
  });
});
