import { describe, expect, it } from "vitest";
import { agentTraceCardModel, cloudTraceSetupPatch } from "./AgentSetupPage";

describe("Agent Setup native trace card", () => {
  it.each([
    ["disabled", "enable", false],
    ["configured", "disable", false],
    ["stale", "repair", false],
    ["conflict", "confirm-overwrite", true],
    ["invalid", null, false],
  ] as const)("maps %s to its safe action", (state, action, irreversibleConfirmation) => {
    expect(agentTraceCardModel(state)).toEqual({ action, irreversibleConfirmation });
  });
});

describe("Agent Setup Ratel Cloud trace onboarding", () => {
  it("builds a daemon-owned settings patch from the current endpoint and pasted key", () => {
    expect(
      cloudTraceSetupPatch(" https://cloud.ratel.sh/api/v1/traces ", " rtl_secret_canary "),
    ).toEqual({
      endpoint: "https://cloud.ratel.sh/api/v1/traces",
      apiKey: "rtl_secret_canary",
    });
  });

  it("refuses to submit an empty API key", () => {
    expect(() => cloudTraceSetupPatch("https://cloud.ratel.sh/api/v1/traces", "   ")).toThrow(
      /API key is required/,
    );
  });
});
