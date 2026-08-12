import { describe, expect, it } from "vitest";
import {
  agentCardStatusModel,
  agentTraceCardModel,
  agentTraceInstallCopy,
  agentTraceLevelChoices,
  agentTraceSelectionModel,
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
      description: "Send native telemetry to Ratel's local relay.",
      title: "Native telemetry",
    });
    expect(agentTraceInstallCopy("configured").actionLabel).toBe("Disable");
    expect(agentTraceInstallCopy("stale").actionLabel).toBe("Repair");
  });

  it("offers honest host-aware detail choices", () => {
    expect(agentTraceLevelChoices("codex").map(({ value }) => value)).toEqual([
      "off",
      "redacted",
      "tool-activity",
      "prompt-content",
    ]);
    expect(agentTraceLevelChoices("codex")[2].description).toMatch(/output snippet/i);
    expect(agentTraceLevelChoices("claude-code").map(({ value }) => value)).toEqual([
      "off",
      "redacted",
      "tool-details",
      "full-content",
    ]);
  });

  it("requires confirmation for content-bearing choices and exporter conflicts", () => {
    expect(agentTraceSelectionModel("configured", "redacted", "full-content")).toEqual({
      actionLabel: "Apply",
      changed: true,
      requiresOverwriteConfirmation: false,
      requiresPrivacyConfirmation: true,
    });
    expect(agentTraceSelectionModel("conflict", "unknown", "tool-details")).toEqual({
      actionLabel: "Review change",
      changed: true,
      requiresOverwriteConfirmation: true,
      requiresPrivacyConfirmation: true,
    });
    expect(agentTraceSelectionModel("conflict", "unknown", "off")).toMatchObject({
      actionLabel: "Keep existing",
      changed: false,
    });
    expect(
      agentTraceSelectionModel("conflict", "unknown", "off", {
        traces: "configured",
        logs: "conflict",
      }),
    ).toMatchObject({ actionLabel: "Turn off", changed: true });
    expect(agentTraceSelectionModel("configured", "redacted", "tool-activity")).toMatchObject({
      requiresPrivacyConfirmation: true,
    });
    expect(
      agentTraceSelectionModel(
        "configured",
        "redacted",
        "tool-activity",
        { traces: "configured", logs: "conflict" },
        "codex",
      ),
    ).toMatchObject({
      actionLabel: "Review change",
      requiresOverwriteConfirmation: true,
      requiresPrivacyConfirmation: true,
    });
    expect(agentTraceSelectionModel("stale", "redacted", "redacted")).toEqual({
      actionLabel: "Repair",
      changed: true,
      requiresOverwriteConfirmation: false,
      requiresPrivacyConfirmation: false,
    });
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
