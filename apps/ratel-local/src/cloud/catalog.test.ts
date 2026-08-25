import { describe, expect, it } from "vitest";
import {
  CloudCatalogAuthError,
  CloudCatalogProtocolError,
  CloudCatalogUnavailableError,
  cloudCatalogEndpoint,
  createCloudCatalogLoader,
} from "./catalog.js";

const ENDPOINT = "https://cloud.ratel.sh/v1/catalog";
const VERSION = "6f7f0cee520a24a6edbb6dc7df6b623751cbdf05771e7e7bbe45cc9de943f0a6";

// Shape taken from a real `GET /v1/catalog` against a seeded project; the
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
    const next = responses[Math.min(index++, responses.length - 1)];
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
  it("pulls the catalog and maps the wire projection onto engine skills", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));
    const { snapshot, degraded } = await loader(impl).load();

    expect(degraded).toBeUndefined();
    expect(snapshot.catalogVersion).toBe(VERSION);
    expect(snapshot.skills).toEqual(WIRE.skills);
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_test");
    // Nothing cached yet, so the first pull must be unconditional.
    expect(calls[0].headers.has("if-none-match")).toBe(false);
  });

  it("revalidates with If-None-Match and reuses the cache on 304", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE), new Response(null, { status: 304 }));
    const client = loader(impl);
    const first = await client.load();
    const second = await client.load();

    expect(calls[1].headers.get("if-none-match")).toBe(`"${VERSION}"`);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.degraded).toBeUndefined();
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

  it("surfaces an invalid credential even when a snapshot is cached", async () => {
    const { impl } = recordingFetch(jsonResponse(WIRE), jsonResponse({ error: "nope" }, 401));
    const client = loader(impl);
    await client.load();
    // A revoked key must not hide behind the last good catalog.
    await expect(client.load()).rejects.toThrow(CloudCatalogAuthError);
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

  it("rejects a 304 that arrives before anything is cached", async () => {
    const { impl } = recordingFetch(new Response(null, { status: 304 }));
    await expect(loader(impl).load()).rejects.toThrow(/304 without a cached catalog/);
  });
});
