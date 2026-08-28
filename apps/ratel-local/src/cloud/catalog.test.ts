import { describe, expect, it } from "vitest";
import { createCloudCatalogLoader, createCloudCatalogSource } from "./catalog.js";
import type { CloudSettings } from "./settings.js";

const ENDPOINT = "https://cloud.ratel.sh/api/v1/catalog";
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
    if (index >= responses.length) throw new Error("no more responses");
    const next = responses[index++];
    if (typeof next === "function") next();
    return next as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const loader = (fetchImpl: typeof fetch) =>
  createCloudCatalogLoader({ endpoint: ENDPOINT, apiKey: "rtl_test", fetch: fetchImpl });

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
    // Nothing cached yet, so the first pull must be unconditional.
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
    await expect(loader(impl).load()).rejects.toThrow(/unavailable and nothing is cached/);
  });

  it("fails on a network error with nothing cached, and degrades with a cache", async () => {
    const boom = () => {
      throw new Error("connect ECONNREFUSED");
    };
    await expect(loader(recordingFetch(boom).impl).load()).rejects.toThrow(
      /unavailable and nothing is cached/,
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
      /unavailable and nothing is cached/,
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
    await expect(client.load()).rejects.toThrow(/auth failed: HTTP 401/);
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
    await expect(client.load()).rejects.toThrow(/auth failed/);
    expect(calls).toHaveLength(1);

    clock = 60_001;
    await client.load();
    expect(calls).toHaveLength(2);
  });

  it("surfaces a contract violation instead of falling back to the cache", async () => {
    const { impl } = recordingFetch(
      jsonResponse(WIRE),
      jsonResponse({ catalogVersion: VERSION, skills: [{ id: "broken" }] }),
    );
    const client = loader(impl);
    await client.load();
    await expect(client.load()).rejects.toThrow(/malformed catalog/);
  });

  it("rejects a skill missing a required wire field", async () => {
    const { tags: _tags, ...missingTags } = WIRE.skills[0];
    await expect(
      loader(
        recordingFetch(jsonResponse({ catalogVersion: VERSION, skills: [missingTags] })).impl,
      ).load(),
    ).rejects.toThrow(/invalid tags or tools/);
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
        /malformed catalog/,
      );
    }
  });

  it("rejects a catalogVersion that is not header-safe", async () => {
    const badVersion = "v1\r\nX-Injected: 1";
    await expect(
      loader(recordingFetch(jsonResponse({ ...WIRE, catalogVersion: badVersion })).impl).load(),
    ).rejects.toThrow(/malformed catalog/);

    const goodAgain = { ...WIRE, catalogVersion: `${VERSION}ff` };
    const { impl } = recordingFetch(
      jsonResponse(WIRE),
      jsonResponse({ ...WIRE, catalogVersion: badVersion }),
      jsonResponse(goodAgain),
    );
    const client = loader(impl);
    await client.load();
    await expect(client.load()).rejects.toThrow(/malformed catalog/);
    const third = await client.load();
    expect(third.snapshot.catalogVersion).toBe(goodAgain.catalogVersion);
    expect(third.degraded).toBeUndefined();
  });

  it("rejects a 304 that arrives before anything is cached", async () => {
    const { impl } = recordingFetch(new Response(null, { status: 304 }));
    await expect(loader(impl).load()).rejects.toThrow(/304 without a cached catalog/);
  });
});

const TRACES = new URL("https://cloud.ratel.sh/api/v1/traces");
const CONTEXT = { kind: "global" } as const;

const SETTINGS: CloudSettings = {
  tracesEndpoint: TRACES.toString(),
  default: "personal",
  profiles: { personal: { apiKey: "rtl_personal" }, acme: { apiKey: "rtl_acme" } },
};

const source = (
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof createCloudCatalogSource>[0]> = {},
) =>
  createCloudCatalogSource({
    settings: () => SETTINGS,
    environment: undefined,
    environmentProfile: undefined,
    log: () => {},
    fetch: fetchImpl,
    ...overrides,
  });

describe("createCloudCatalogSource", () => {
  it("pulls the profile a scope names, over the store default", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await source(impl)(CONTEXT, "acme");

    expect(calls[0].url).toBe("https://cloud.ratel.sh/api/v1/catalog");
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_acme");
  });

  it("lets the environment credential outrank the profile a scope names", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));
    const environment = {
      catalog: new URL("https://cloud.ratel.sh/api/v1/catalog"),
      apiKey: "rtl_env",
    };

    await source(impl, { environment })(CONTEXT, "acme");

    expect(calls[0].url).toBe("https://cloud.ratel.sh/api/v1/catalog");
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_env");
  });

  it("lets RATEL_PROFILE outrank the profile a scope names", async () => {
    // ADR-0021 puts the environment above layered config, as AWS_PROFILE does.
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await source(impl, { environmentProfile: "personal" })(CONTEXT, "acme");

    expect(calls[0].url).toBe("https://cloud.ratel.sh/api/v1/catalog");
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_personal");
  });

  it("refuses a RATEL_PROFILE the store does not define", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await expect(source(impl, { environmentProfile: "nope" })(CONTEXT, "acme")).rejects.toThrow(
      /"nope" \(RATEL_PROFILE\)/,
    );
    expect(calls).toHaveLength(0);
  });

  it("falls back to the store default when no scope names a profile", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await source(impl)(CONTEXT);

    expect(calls[0].url).toBe("https://cloud.ratel.sh/api/v1/catalog");
    expect(calls[0].headers.get("authorization")).toBe("Bearer rtl_personal");
  });

  it("refuses a named profile the store does not define", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await expect(source(impl)(CONTEXT, "nope")).rejects.toThrow(/"nope" \(cloud\.profile\)/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a named profile when nothing is stored at all", async () => {
    // Falling back here would pull another project's catalog and report success.
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    await expect(
      source(impl, { settings: () => undefined, environment: undefined })(CONTEXT, "acme"),
    ).rejects.toThrow(/no Cloud credential is stored/);
    expect(calls).toHaveLength(0);
  });

  it("keeps one loader per credential, so a repeated pull revalidates", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE), new Response(null, { status: 304 }));
    const pull = source(impl);

    await pull(CONTEXT, "acme");
    await pull(CONTEXT, "acme");

    expect(calls[1].headers.get("if-none-match")).toBe(`"${VERSION}"`);
  });

  it("picks up a key rotated while the daemon runs", async () => {
    // The store is replaced on a UI save; a source holding the boot copy would
    // keep pulling with the old key until restart.
    const { calls, impl } = recordingFetch(jsonResponse(WIRE), jsonResponse(WIRE));
    let stored = SETTINGS;
    const pull = source(impl, { settings: () => stored });

    await pull(CONTEXT, "acme");
    stored = { ...SETTINGS, profiles: { ...SETTINGS.profiles, acme: { apiKey: "rtl_rotated" } } };
    await pull(CONTEXT, "acme");

    expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
      "Bearer rtl_acme",
      "Bearer rtl_rotated",
    ]);
  });

  it("returns nothing when no credential resolves", async () => {
    const { calls, impl } = recordingFetch(jsonResponse(WIRE));

    const pulled = await source(impl, { settings: () => undefined })(CONTEXT);

    expect(pulled).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
