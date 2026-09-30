import { describe, expect, it } from "vitest";
import { detectOutputEnvironment } from "./environment.js";

const terminal = { isTTY: true, columns: 100 };
const input = { stdin: terminal, stdout: terminal, stderr: terminal, env: { TERM: "xterm" } };

describe("output environment", () => {
  it("enables formatting and questions in a terminal", () => {
    expect(detectOutputEnvironment(input)).toEqual({
      interactive: true,
      prompt: true,
      color: true,
      width: 100,
    });
  });

  it.each(["stdin", "stderr"] as const)("disables questions when %s is redirected", (stream) => {
    expect(detectOutputEnvironment({ ...input, [stream]: { isTTY: false } })).toMatchObject({
      interactive: false,
      prompt: false,
    });
  });

  it("keeps questions but uses plain output when only stdout is redirected", () => {
    expect(detectOutputEnvironment({ ...input, stdout: { isTTY: false } })).toEqual({
      interactive: false,
      prompt: true,
      color: false,
      width: 80,
    });
  });

  it.each([
    "stdout",
    "stderr",
  ] as const)("uses plain text when %s is redirected, even with FORCE_COLOR", (stream) => {
    expect(
      detectOutputEnvironment({ ...input, [stream]: {}, env: { FORCE_COLOR: "1" } }).color,
    ).toBe(false);
  });

  it("keeps CI deterministic even when it provides a terminal", () => {
    expect(detectOutputEnvironment({ ...input, env: { CI: "true", FORCE_COLOR: "1" } })).toEqual({
      interactive: false,
      prompt: false,
      color: false,
      width: 80,
    });
    expect(detectOutputEnvironment({ ...input, env: { CI: "false" } }).interactive).toBe(true);
  });

  it("respects NO_COLOR without disabling questions", () => {
    expect(detectOutputEnvironment({ ...input, env: { NO_COLOR: "1" } })).toEqual({
      interactive: true,
      prompt: true,
      color: false,
      width: 100,
    });
  });

  it("handles dumb terminals and missing dimensions", () => {
    expect(detectOutputEnvironment({ ...input, env: { TERM: "dumb" } })).toEqual({
      interactive: false,
      prompt: true,
      color: false,
      width: 80,
    });
    expect(detectOutputEnvironment({ ...input, stderr: { isTTY: true } }).width).toBe(80);
  });
});
