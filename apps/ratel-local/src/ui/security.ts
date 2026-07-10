import { randomBytes, timingSafeEqual } from "node:crypto";

export const UI_HOST = "127.0.0.1";

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host.toLowerCase() === `${UI_HOST}:${port}` || host.toLowerCase() === `localhost:${port}`;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function extractBearer(authHeader: string | string[] | undefined): string | null {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value) return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/i.exec(value);
  return match ? match[1] : null;
}

export function extractTokenFromUrl(url: string): string | null {
  const idx = url.indexOf("?");
  if (idx < 0) return null;
  const params = new URLSearchParams(url.slice(idx + 1));
  return params.get("t");
}
