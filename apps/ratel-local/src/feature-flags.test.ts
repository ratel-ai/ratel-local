import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_RANKING_FEATURE_ENV,
  CLOUD_CATALOG_FEATURE_ENV,
  CLOUD_TELEMETRY_FEATURE_ENV,
  featureFlagOverridesFromEnv,
  featureFlagServiceEnvironment,
  featureFlagsFromEnv,
  SKILL_STORAGE_FEATURE_ENV,
} from "./feature-flags.js";

const OFF = {
  adaptiveRanking: false,
  cloudTelemetry: false,
  cloudCatalog: false,
  skillStorage: false,
};

describe("feature flags", () => {
  it("keeps flags off by default and accepts only an explicit 1", () => {
    expect(featureFlagsFromEnv({})).toEqual(OFF);
    expect(
      featureFlagsFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "0",
        [CLOUD_CATALOG_FEATURE_ENV]: "true",
        [SKILL_STORAGE_FEATURE_ENV]: "yes",
      }),
    ).toEqual(OFF);
    expect(
      featureFlagsFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
        [CLOUD_CATALOG_FEATURE_ENV]: "1",
        [SKILL_STORAGE_FEATURE_ENV]: "1",
      }),
    ).toEqual({
      adaptiveRanking: false,
      cloudTelemetry: true,
      cloudCatalog: true,
      skillStorage: true,
    });
  });

  it("keeps adaptive ranking off by default and accepts only an explicit 1", () => {
    expect(featureFlagsFromEnv({}).adaptiveRanking).toBe(false);
    expect(featureFlagsFromEnv({ [ADAPTIVE_RANKING_FEATURE_ENV]: "0" }).adaptiveRanking).toBe(
      false,
    );
    expect(featureFlagsFromEnv({ [ADAPTIVE_RANKING_FEATURE_ENV]: "true" }).adaptiveRanking).toBe(
      false,
    );
    expect(featureFlagsFromEnv({ [ADAPTIVE_RANKING_FEATURE_ENV]: "1" }).adaptiveRanking).toBe(true);
  });

  it("persists only enabled flags into daemon service environments", () => {
    expect(featureFlagServiceEnvironment({ adaptiveRanking: true })).toEqual({
      [ADAPTIVE_RANKING_FEATURE_ENV]: "1",
    });
    expect(featureFlagServiceEnvironment({})).toEqual({});
    expect(featureFlagServiceEnvironment(OFF)).toEqual({});
    expect(featureFlagServiceEnvironment({ cloudTelemetry: true })).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
    });
    expect(featureFlagServiceEnvironment({ cloudCatalog: true })).toEqual({
      [CLOUD_CATALOG_FEATURE_ENV]: "1",
    });
    expect(featureFlagServiceEnvironment({ skillStorage: true })).toEqual({
      [SKILL_STORAGE_FEATURE_ENV]: "1",
    });
    expect(
      featureFlagServiceEnvironment({
        cloudTelemetry: true,
        cloudCatalog: true,
        skillStorage: true,
      }),
    ).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
      [CLOUD_CATALOG_FEATURE_ENV]: "1",
      [SKILL_STORAGE_FEATURE_ENV]: "1",
    });
  });

  it("reports only the flags the environment names, so changing one never moves another", () => {
    expect(featureFlagOverridesFromEnv({})).toEqual({});
    expect(featureFlagOverridesFromEnv({ [CLOUD_TELEMETRY_FEATURE_ENV]: "1" })).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: true,
    });
    expect(featureFlagOverridesFromEnv({ [CLOUD_CATALOG_FEATURE_ENV]: "0" })).toEqual({
      [CLOUD_CATALOG_FEATURE_ENV]: false,
    });
    expect(featureFlagOverridesFromEnv({ [SKILL_STORAGE_FEATURE_ENV]: "1" })).toEqual({
      [SKILL_STORAGE_FEATURE_ENV]: true,
    });
    // Presence is the override signal; only exact `1` enables.
    expect(
      featureFlagOverridesFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "true",
        [CLOUD_CATALOG_FEATURE_ENV]: "1",
        [SKILL_STORAGE_FEATURE_ENV]: "",
      }),
    ).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: false,
      [CLOUD_CATALOG_FEATURE_ENV]: true,
      [SKILL_STORAGE_FEATURE_ENV]: false,
    });
  });

  it("treats adaptive-ranking env presence as an explicit service override", () => {
    expect(featureFlagOverridesFromEnv({})).toEqual({});
    expect(featureFlagOverridesFromEnv({ [ADAPTIVE_RANKING_FEATURE_ENV]: "1" })).toEqual({
      [ADAPTIVE_RANKING_FEATURE_ENV]: true,
    });
    expect(featureFlagOverridesFromEnv({ [ADAPTIVE_RANKING_FEATURE_ENV]: "0" })).toEqual({
      [ADAPTIVE_RANKING_FEATURE_ENV]: false,
    });
  });
});
