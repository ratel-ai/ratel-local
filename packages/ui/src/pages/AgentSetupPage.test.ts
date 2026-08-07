import { describe, expect, it } from "vitest";
import {
  agentCardStatusModel,
  agentTraceCardModel,
  agentTraceInstallCopy,
  cloudTraceSetupPatch,
} from "./AgentSetupPage";

describe("Agent card status", () => {
  it("collapses connected and covered state into one quiet summary", () => {
    expect(
      agentCardStatusModel({
        connectionKind: "plugin",
        linked: true,
        missingToolCount: 0,
        posture: "ratel-only",
        unmanagedSkillCount: 0,
      }),
    ).toEqual({
      connectionLabel: "Plugin connected",
      healthLabel: "Ready",
      tone: "success",
    });
  });

  it("combines tool and skill attention into a single label", () => {
    expect(
      agentCardStatusModel({
        connectionKind: "plugin",
        linked: true,
        missingToolCount: 4,
        posture: "mixed",
        unmanagedSkillCount: 1,
      }),
    ).toEqual({
      connectionLabel: "Plugin connected",
      healthLabel: "4 tools · 1 skill need setup",
      tone: "warning",
    });
  });
});

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

  it("uses the same compact install language as other agent actions", () => {
    expect(agentTraceInstallCopy("disabled")).toEqual({
      actionLabel: "Enable",
      description: "Send native traces to Ratel's local relay.",
      title: "Native traces",
    });
    expect(agentTraceInstallCopy("configured").actionLabel).toBe("Disable");
    expect(agentTraceInstallCopy("stale").actionLabel).toBe("Repair");
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
