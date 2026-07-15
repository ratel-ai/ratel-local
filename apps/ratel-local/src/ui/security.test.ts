import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  extractBearer,
  extractTokenFromUrl,
  InMemoryUiSessionTokens,
  isLoopbackHost,
  newSessionToken,
} from "./security.js";

describe("newSessionToken", () => {
  it("returns a 64-char hex string", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns a distinct token each call", () => {
    expect(newSessionToken()).not.toBe(newSessionToken());
  });
});

describe("InMemoryUiSessionTokens", () => {
  it("issues session tokens that live only in memory", () => {
    const sessions = new InMemoryUiSessionTokens();
    const token = sessions.issue();
    expect(sessions.isValid(token)).toBe(true);
    expect(sessions.isValid("wrong")).toBe(false);
    sessions.revoke(token);
    expect(sessions.isValid(token)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("accepts 127.0.0.1 with the right port", () => {
    expect(isLoopbackHost("127.0.0.1:5731", 5731)).toBe(true);
  });
  it("accepts localhost with the right port", () => {
    expect(isLoopbackHost("localhost:5731", 5731)).toBe(true);
  });
  it("rejects wrong port", () => {
    expect(isLoopbackHost("127.0.0.1:9999", 5731)).toBe(false);
  });
  it("rejects non-loopback hosts", () => {
    expect(isLoopbackHost("evil.example.com:5731", 5731)).toBe(false);
  });
  it("rejects missing host header", () => {
    expect(isLoopbackHost(undefined, 5731)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  it("returns false for different strings", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length strings", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("extractBearer", () => {
  it("parses a bearer token", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
  });
  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer abc123")).toBe("abc123");
  });
  it("returns null on a non-bearer header", () => {
    expect(extractBearer("Basic abc123")).toBe(null);
  });
  it("returns null on undefined", () => {
    expect(extractBearer(undefined)).toBe(null);
  });
});

describe("extractTokenFromUrl", () => {
  it("returns the t param when present", () => {
    expect(extractTokenFromUrl("/?t=abc123")).toBe("abc123");
  });
  it("returns null when there is no query string", () => {
    expect(extractTokenFromUrl("/")).toBe(null);
  });
  it("returns null when t param is absent", () => {
    expect(extractTokenFromUrl("/?other=x")).toBe(null);
  });
});
