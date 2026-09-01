import { describe, expect, it } from "vitest";
import {
  CLOUD_CATALOG_FEATURE_ENV,
  CLOUD_TELEMETRY_FEATURE_ENV,
  featureFlagOverridesFromEnv,
  featureFlagServiceEnvironment,
  featureFlagsFromEnv,
} from "./feature-flags.js";

describe("feature flags", () => {
  it("keeps flags off by default and accepts only an explicit 1", () => {
    expect(featureFlagsFromEnv({})).toEqual({ cloudTelemetry: false, cloudCatalog: false });
    expect(
      featureFlagsFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "0",
        [CLOUD_CATALOG_FEATURE_ENV]: "true",
      }),
    ).toEqual({ cloudTelemetry: false, cloudCatalog: false });
    expect(
      featureFlagsFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
        [CLOUD_CATALOG_FEATURE_ENV]: "1",
      }),
    ).toEqual({ cloudTelemetry: true, cloudCatalog: true });
  });

  it("persists only enabled flags into daemon service environments", () => {
    expect(featureFlagServiceEnvironment({ cloudTelemetry: false, cloudCatalog: false })).toEqual(
      {},
    );
    expect(featureFlagServiceEnvironment({ cloudTelemetry: true, cloudCatalog: false })).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
    });
    expect(featureFlagServiceEnvironment({ cloudTelemetry: false, cloudCatalog: true })).toEqual({
      [CLOUD_CATALOG_FEATURE_ENV]: "1",
    });
    expect(featureFlagServiceEnvironment({ cloudTelemetry: true, cloudCatalog: true })).toEqual({
      [CLOUD_TELEMETRY_FEATURE_ENV]: "1",
      [CLOUD_CATALOG_FEATURE_ENV]: "1",
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
    // Presence is the override signal; only exact `1` enables.
    expect(
      featureFlagOverridesFromEnv({
        [CLOUD_TELEMETRY_FEATURE_ENV]: "true",
        [CLOUD_CATALOG_FEATURE_ENV]: "1",
      }),
    ).toEqual({ [CLOUD_TELEMETRY_FEATURE_ENV]: false, [CLOUD_CATALOG_FEATURE_ENV]: true });
  });
});
