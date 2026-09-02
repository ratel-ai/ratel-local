import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cloudOtlpRelayOptionsFromEnv,
  createCloudOtlpTraceRelay,
  createCloudOtlpTraceRelayController,
  OTLP_LOGS_PATH,
  OTLP_PROTOBUF_CONTENT_TYPE,
  OTLP_TRACES_PATH,
} from "./otlp-trace-relay.js";

const CLOUD_ENDPOINT = "https://cloud.example.test/otlp/v1/traces";
const CLOUD_SECRET = "cloud-secret-must-not-leak";
const TRACE_PAYLOAD = Buffer.from([0x0a, 0x00]);
const LOG_PAYLOAD = Buffer.from([0x12, 0x03, 0x6c, 0x6f, 0x67]);

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe("Cloud OTLP trace relay configuration", () => {
  it("requires no feature flag and activates when daemon-owned environment values are present", () => {
    expect(cloudOtlpRelayOptionsFromEnv({})).toBeUndefined();
    expect(() =>
      cloudOtlpRelayOptionsFromEnv({
        RATEL_CLOUD_OTLP_TRACES_ENDPOINT: CLOUD_ENDPOINT,
      }),
    ).toThrow(/credential/i);

    expect(
      cloudOtlpRelayOptionsFromEnv({
        RATEL_CLOUD_OTLP_TRACES_ENDPOINT: CLOUD_ENDPOINT,
        RATEL_API_KEY: CLOUD_SECRET,
      }),
    ).toMatchObject({
      endpoint: new URL(CLOUD_ENDPOINT),
      logsEndpoint: new URL("https://cloud.example.test/api/v1/logs"),
      apiKey: CLOUD_SECRET,
    });
  });

  it("requires a secret-free HTTPS Cloud endpoint", () => {
    for (const endpoint of [
      "http://cloud.example.test/otlp/v1/traces",
      "https://key@cloud.example.test/otlp/v1/traces",
      "https://cloud.example.test/otlp/v1/traces?api_key=secret",
      "not-a-url",
    ]) {
      expect(() =>
        cloudOtlpRelayOptionsFromEnv({
          RATEL_CLOUD_OTLP_TRACES_ENDPOINT: endpoint,
          RATEL_API_KEY: CLOUD_SECRET,
        }),
      ).toThrow(/endpoint/i);
    }
  });
});

describe("Cloud OTLP relay controller", () => {
  it("keeps the route available before setup and activates it without a restart", async () => {
    const controller = createCloudOtlpTraceRelayController();
    const server = createHttpServer((request, response) => {
      void controller.handleRequest(request, response, (request.url ?? "/").split("?")[0] ?? "/");
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = new URL(`http://127.0.0.1:${address.port}`);

    expect((await postTrace(baseUrl)).status).toBe(503);
    expect((await postLogs(baseUrl)).status).toBe(503);

    const fetchUpstream = vi.fn(async () => new Response(Buffer.from([0x00]), { status: 200 }));
    controller.configure({
      endpoint: new URL(CLOUD_ENDPOINT),
      apiKey: CLOUD_SECRET,
      fetch: fetchUpstream,
    });

    expect((await postTrace(baseUrl)).status).toBe(200);
    expect((await postLogs(baseUrl)).status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
  });
});

describe("Cloud OTLP/HTTP trace relay", () => {
  it("forwards protobuf bytes and injects only the daemon-held Cloud authorization", async () => {
    const fetchUpstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${CLOUD_SECRET}`);
      expect(headers.get("content-type")).toBe(OTLP_PROTOBUF_CONTENT_TYPE);
      expect(headers.get("x-local-only")).toBeNull();
      expect(Buffer.from((init?.body as Uint8Array) ?? [])).toEqual(TRACE_PAYLOAD);
      return new Response(Buffer.from([0x00]), {
        status: 200,
        headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
      });
    });
    const baseUrl = await spinRelay({ fetch: fetchUpstream });

    const response = await fetch(new URL(OTLP_TRACES_PATH, baseUrl), {
      method: "POST",
      headers: {
        Authorization: "Bearer local-exporter-token",
        "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE,
        "X-Local-Only": "must-not-forward",
      },
      body: TRACE_PAYLOAD,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(OTLP_PROTOBUF_CONTENT_TYPE);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0x00]));
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(String(fetchUpstream.mock.calls[0]?.[0])).toBe(CLOUD_ENDPOINT);
  });

  it("forwards Codex and Claude log protobuf bytes unchanged to the derived Cloud logs route", async () => {
    const fetchUpstream = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(Buffer.from((init?.body as Uint8Array) ?? [])).toEqual(LOG_PAYLOAD);
      return new Response(Buffer.from([0x00]), {
        status: 200,
        headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
      });
    });
    const baseUrl = await spinRelay({ fetch: fetchUpstream });

    const response = await postLogs(baseUrl);

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(String(fetchUpstream.mock.calls[0]?.[0])).toBe("https://cloud.example.test/api/v1/logs");
  });

  it("handles only the exact trace route and rejects unsupported methods", async () => {
    const fetchUpstream = vi.fn<typeof fetch>();
    const baseUrl = await spinRelay({ fetch: fetchUpstream });

    expect((await fetch(new URL("/otlp/v1/metrics", baseUrl))).status).toBe(404);
    const method = await fetch(new URL(OTLP_TRACES_PATH, baseUrl));
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("rejects missing bodies and non-protobuf content types before forwarding", async () => {
    const fetchUpstream = vi.fn<typeof fetch>();
    const baseUrl = await spinRelay({ fetch: fetchUpstream });

    const empty = await fetch(new URL(OTLP_TRACES_PATH, baseUrl), {
      method: "POST",
      headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(400);

    const json = await fetch(new URL(OTLP_TRACES_PATH, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("bounds the request body before forwarding", async () => {
    const fetchUpstream = vi.fn<typeof fetch>();
    const baseUrl = await spinRelay({ fetch: fetchUpstream, maxBodyBytes: 4 });

    const response = await fetch(new URL(OTLP_TRACES_PATH, baseUrl), {
      method: "POST",
      headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
      body: Buffer.alloc(5),
    });

    expect(response.status).toBe(413);
    expect(await postChunkedTrace(baseUrl, [Buffer.alloc(3), Buffer.alloc(2)])).toBe(413);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it("returns sanitized upstream statuses without exposing response bodies or credentials", async () => {
    const logs: string[] = [];
    const baseUrl = await spinRelay({
      log: (message) => logs.push(message),
      fetch: async () =>
        new Response(`upstream echoed ${CLOUD_SECRET}`, {
          status: 429,
          headers: { "Content-Type": "text/plain", "Retry-After": "30" },
        }),
    });

    const response = await postTrace(baseUrl);
    const responseText = await response.text();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(responseText).toContain("429");
    expect(`${responseText}\n${logs.join("\n")}`).not.toContain(CLOUD_SECRET);
  });

  it("maps network failures and timeouts to clear sanitized relay errors", async () => {
    const networkLogs: string[] = [];
    const unavailable = await spinRelay({
      log: (message) => networkLogs.push(message),
      fetch: async () => {
        throw new Error(`connect failed with ${CLOUD_SECRET}`);
      },
    });
    const unavailableResponse = await postTrace(unavailable);
    const unavailableText = await unavailableResponse.text();
    expect(unavailableResponse.status).toBe(502);
    expect(unavailableText).toMatch(/unavailable/i);
    expect(`${unavailableText}\n${networkLogs.join("\n")}`).not.toContain(CLOUD_SECRET);

    const timeoutLogs: string[] = [];
    const timedOut = await spinRelay({
      timeoutMs: 5,
      log: (message) => timeoutLogs.push(message),
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectTimeout = () => reject(signal?.reason ?? new Error("aborted"));
          if (signal?.aborted) rejectTimeout();
          else signal?.addEventListener("abort", rejectTimeout, { once: true });
        }),
    });
    const timeoutResponse = await postTrace(timedOut);
    const timeoutText = await timeoutResponse.text();
    expect(timeoutResponse.status).toBe(504);
    expect(timeoutText).toMatch(/timed out/i);
    expect(`${timeoutText}\n${timeoutLogs.join("\n")}`).not.toContain(CLOUD_SECRET);
  });
});

interface SpinRelayOptions {
  fetch?: typeof fetch;
  log?: (message: string) => void;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

async function spinRelay(options: SpinRelayOptions = {}): Promise<URL> {
  const relay = createCloudOtlpTraceRelay({
    endpoint: new URL(CLOUD_ENDPOINT),
    logsEndpoint: new URL("https://cloud.example.test/api/v1/logs"),
    apiKey: CLOUD_SECRET,
    fetch: options.fetch ?? (async () => new Response(null, { status: 200 })),
    log: options.log,
    maxBodyBytes: options.maxBodyBytes,
    timeoutMs: options.timeoutMs,
  });
  const server = createHttpServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    relay
      .handleRequest(request, response, path)
      .then((handled) => {
        if (handled) return;
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("not found\n");
      })
      .catch(() => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("test relay failure\n");
      });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  expect(address.address).toBe("127.0.0.1");
  return new URL(`http://127.0.0.1:${address.port}`);
}

function postTrace(baseUrl: URL): Promise<Response> {
  return fetch(new URL(OTLP_TRACES_PATH, baseUrl), {
    method: "POST",
    headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
    body: TRACE_PAYLOAD,
  });
}

function postLogs(baseUrl: URL): Promise<Response> {
  return fetch(new URL(OTLP_LOGS_PATH, baseUrl), {
    method: "POST",
    headers: { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE },
    body: LOG_PAYLOAD,
  });
}

function postChunkedTrace(baseUrl: URL, chunks: Buffer[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: baseUrl.hostname,
        port: Number(baseUrl.port),
        path: OTLP_TRACES_PATH,
        method: "POST",
        headers: {
          "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE,
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    for (const chunk of chunks.slice(0, -1)) request.write(chunk);
    request.end(chunks.at(-1));
  });
}
