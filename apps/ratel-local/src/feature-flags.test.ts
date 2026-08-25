import { describe, expect, it } from "vitest";
import {
  CLOUD_TELEMETRY_FEATURE_ENV,
  cloudTelemetryOverrideFromEnv,
  featureFlagServiceEnvironment,
  featureFlagsFromEnv,
} from "./feature-flags.js";

describe("feature flags", () => {
  it("keeps cloud telemetry off by default and accepts only an explicit 1", () => {
    expect(featureFlagsFromEnv({}).cloudTelemetry).toBe(false);
    expect(featureFlagsFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "0" }).cloudTelemetry).toBe(false);
    expect(featureFlagsFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "true" }).cloudTelemetry).toBe(
      false,
    );
    expect(featureFlagsFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "1" }).cloudTelemetry).toBe(true);
  });

  it("persists only enabled flags into daemon service environments", () => {
    expect(featureFlagServiceEnvironment({ cloudTelemetry: false })).toEqual({});
    expect(featureFlagServiceEnvironment({ cloudTelemetry: true })).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
    });
  });

  it("treats Cloud telemetry env presence as an explicit service override", () => {
    expect(cloudTelemetryOverrideFromEnv({})).toBeUndefined();
    expect(cloudTelemetryOverrideFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "1" })).toBe(true);
    expect(cloudTelemetryOverrideFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "0" })).toBe(false);
    expect(cloudTelemetryOverrideFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "" })).toBe(false);
    expect(cloudTelemetryOverrideFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "true" })).toBe(false);
  });
});
