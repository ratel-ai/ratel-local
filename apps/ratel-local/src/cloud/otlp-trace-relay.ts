import type { IncomingMessage, ServerResponse } from "node:http";

export const OTLP_TRACES_PATH = "/otlp/v1/traces";
export const OTLP_LOGS_PATH = "/otlp/v1/logs";
export const OTLP_PROTOBUF_CONTENT_TYPE = "application/x-protobuf";
export const CLOUD_OTLP_TRACES_ENDPOINT_ENV = "RATEL_CLOUD_OTLP_TRACES_ENDPOINT";
export const CLOUD_API_KEY_ENV = "RATEL_API_KEY";

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface CloudOtlpTraceRelayOptions {
  endpoint: URL;
  logsEndpoint?: URL;
  apiKey: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  maxBodyBytes?: number;
  timeoutMs?: number;
}

export interface CloudOtlpTraceRelay {
  handleRequest(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

export interface CloudOtlpTraceRelayController extends CloudOtlpTraceRelay {
  configure(options: CloudOtlpTraceRelayOptions): void;
}

export function cloudOtlpRelayOptionsFromEnv(
  env: NodeJS.ProcessEnv,
): CloudOtlpTraceRelayOptions | undefined {
  const endpointValue = env[CLOUD_OTLP_TRACES_ENDPOINT_ENV];
  const apiKey = env[CLOUD_API_KEY_ENV];
  if (!endpointValue && !apiKey) return undefined;
  if (!endpointValue) {
    throw new Error(
      `Cloud OTLP trace relay requires endpoint environment variable ${CLOUD_OTLP_TRACES_ENDPOINT_ENV}`,
    );
  }
  if (!apiKey) {
    throw new Error(
      `Cloud OTLP trace relay requires daemon credential environment variable ${CLOUD_API_KEY_ENV}`,
    );
  }
  return cloudOtlpTraceRelayOptions({ endpoint: endpointValue, apiKey });
}

export function cloudOtlpTraceRelayOptions(settings: {
  endpoint: string;
  apiKey: string;
}): CloudOtlpTraceRelayOptions {
  const endpoint = parseCloudEndpoint(settings.endpoint);
  if (!settings.apiKey.trim() || /[\r\n]/.test(settings.apiKey)) {
    throw new Error("Ratel Cloud API key is required and must fit in an HTTP header");
  }
  return {
    endpoint,
    logsEndpoint: deriveCloudOtlpLogsEndpoint(endpoint),
    apiKey: settings.apiKey,
  };
}

export function deriveCloudOtlpLogsEndpoint(traceEndpoint: URL): URL {
  const match = /\/traces(\/?)$/.exec(traceEndpoint.pathname);
  if (!match) {
    throw new Error("Ratel Cloud OTLP trace endpoint path must end with /traces");
  }
  const logsEndpoint = new URL(traceEndpoint);
  logsEndpoint.pathname = `${traceEndpoint.pathname.slice(0, match.index)}/logs${match[1]}`;
  return logsEndpoint;
}

export function createCloudOtlpTraceRelayController(
  initial?: CloudOtlpTraceRelayOptions,
): CloudOtlpTraceRelayController {
  let relay = initial ? createCloudOtlpTraceRelay(initial) : undefined;
  return {
    configure(options) {
      relay = createCloudOtlpTraceRelay(options);
    },
    async handleRequest(req, res, path) {
      const signal = signalForPath(path);
      if (!signal) return false;
      if (!relay) {
        req.resume();
        writePlain(res, 503, `Ratel Cloud ${signal} are not configured\n`);
        return true;
      }
      return relay.handleRequest(req, res, path);
    },
  };
}

export function createCloudOtlpTraceRelay(
  options: CloudOtlpTraceRelayOptions,
): CloudOtlpTraceRelay {
  const fetchUpstream = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const maxBodyBytes = positiveInteger(
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    "body limit",
  );
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "upstream timeout");
  const logsEndpoint = options.logsEndpoint ?? deriveCloudOtlpLogsEndpoint(options.endpoint);

  return {
    async handleRequest(req, res, path) {
      const signal = signalForPath(path);
      if (!signal) return false;
      const endpoint = signal === "traces" ? options.endpoint : logsEndpoint;
      const signalLabel = signal === "traces" ? "Trace" : "Log";

      if (req.method !== "POST") {
        req.resume();
        writePlain(res, 405, "Method not allowed\n", { Allow: "POST" });
        return true;
      }

      if (!isProtobufContentType(firstHeader(req.headers["content-type"]))) {
        req.resume();
        writePlain(res, 415, `Content-Type must be ${OTLP_PROTOBUF_CONTENT_TYPE}\n`);
        return true;
      }

      const declaredLength = firstHeader(req.headers["content-length"]);
      if (declaredLength !== undefined) {
        const parsedLength = Number(declaredLength);
        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
          req.resume();
          writePlain(res, 400, "Invalid Content-Length\n");
          return true;
        }
        if (parsedLength > maxBodyBytes) {
          req.resume();
          writePlain(res, 413, `${signalLabel} payload too large\n`);
          return true;
        }
      }

      const body = await readBoundedBody(req, maxBodyBytes);
      if (body === undefined) {
        writePlain(res, 413, `${signalLabel} payload too large\n`);
        return true;
      }
      if (body.length === 0) {
        writePlain(res, 400, `${signalLabel} payload is empty\n`);
        return true;
      }

      const abortSignal = AbortSignal.timeout(timeoutMs);
      try {
        const upstream = await fetchUpstream(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE,
          },
          body: Uint8Array.from(body),
          redirect: "error",
          signal: abortSignal,
        });

        if (upstream.status < 200 || upstream.status >= 300) {
          log(`[ratel] Cloud OTLP ${signal} relay upstream returned HTTP ${upstream.status}`);
          const retryAfter = safeRetryAfter(upstream.headers.get("retry-after"));
          writePlain(
            res,
            validHttpStatus(upstream.status) ? upstream.status : 502,
            `Ratel Cloud ${signal} endpoint returned HTTP ${upstream.status}\n`,
            retryAfter ? { "Retry-After": retryAfter } : undefined,
          );
          return true;
        }

        const responseBody = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { "Content-Type": OTLP_PROTOBUF_CONTENT_TYPE });
        res.end(responseBody);
        return true;
      } catch {
        if (abortSignal.aborted) {
          log(`[ratel] Cloud OTLP ${signal} relay upstream timed out`);
          writePlain(res, 504, `Ratel Cloud ${signal} endpoint timed out\n`);
        } else {
          log(`[ratel] Cloud OTLP ${signal} relay upstream unavailable`);
          writePlain(res, 502, `Ratel Cloud ${signal} endpoint unavailable\n`);
        }
        return true;
      }
    },
  };
}

function signalForPath(path: string): "traces" | "logs" | undefined {
  if (path === OTLP_TRACES_PATH) return "traces";
  if (path === OTLP_LOGS_PATH) return "logs";
  return undefined;
}

function parseCloudEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`Cloud OTLP trace endpoint in ${CLOUD_OTLP_TRACES_ENDPOINT_ENV} is invalid`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      `Cloud OTLP trace endpoint in ${CLOUD_OTLP_TRACES_ENDPOINT_ENV} must be a secret-free HTTPS URL`,
    );
  }
  return endpoint;
}

async function readBoundedBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.resume();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function isProtobufContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === OTLP_PROTOBUF_CONTENT_TYPE;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeRetryAfter(value: string | null): string | undefined {
  if (!value || value.length > 128) return undefined;
  if (/^\d+$/.test(value)) return value;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toUTCString() === value
    ? value
    : undefined;
}

function validHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

function positiveInteger(value: number, description: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Cloud OTLP relay ${description} must be a positive integer`);
  }
  return value;
}

function writePlain(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(message);
}
