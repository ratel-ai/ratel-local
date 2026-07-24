import { randomBytes, timingSafeEqual } from "node:crypto";

export const UI_HOST = "127.0.0.1";

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}

const UI_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_UI_SESSION_TOKENS = 32;

export interface UiSessionTokenOptions {
  now?: () => number;
  lifetimeMs?: number;
  capacity?: number;
}

export class InMemoryUiSessionTokens {
  private readonly tokens = new Map<string, number>();
  private readonly now: () => number;
  private readonly lifetimeMs: number;
  private readonly capacity: number;

  constructor(initialTokens: Iterable<string> = [], options: UiSessionTokenOptions = {}) {
    this.now = options.now ?? Date.now;
    this.lifetimeMs = options.lifetimeMs ?? UI_SESSION_LIFETIME_MS;
    this.capacity = options.capacity ?? MAX_UI_SESSION_TOKENS;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1) {
      throw new Error("UI session token capacity must be a positive integer");
    }
    if (!Number.isFinite(this.lifetimeMs) || this.lifetimeMs <= 0) {
      throw new Error("UI session token lifetime must be positive");
    }
    for (const token of initialTokens) this.remember(token, this.now());
  }

  issue(): string {
    const now = this.now();
    this.removeExpired(now);
    const token = newSessionToken();
    this.remember(token, now);
    return token;
  }

  isValid(candidate: string): boolean {
    const now = this.now();
    this.removeExpired(now);
    for (const [token] of this.tokens) {
      if (constantTimeEqual(candidate, token)) return true;
    }
    return false;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }

  private remember(token: string, issuedAt: number): void {
    this.removeExpired(issuedAt);
    this.tokens.delete(token);
    while (this.tokens.size >= this.capacity) {
      const oldest = this.tokens.keys().next().value;
      if (typeof oldest !== "string") break;
      this.tokens.delete(oldest);
    }
    this.tokens.set(token, issuedAt + this.lifetimeMs);
  }

  private removeExpired(now: number): void {
    for (const [token, expiresAt] of this.tokens) {
      if (now >= expiresAt) this.tokens.delete(token);
    }
  }
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
