export const CLOUD_TELEMETRY_FEATURE_ENV = "RATEL_FEATURE_CLOUD_TELEMETRY";
export const CLOUD_CATALOG_FEATURE_ENV = "RATEL_FEATURE_CLOUD_CATALOG";

export interface FeatureFlags {
  cloudTelemetry: boolean;
  cloudCatalog: boolean;
}

/**
 * Resolve daemon-wide feature flags from the startup environment. Flags are
 * deliberately opt-in: only the exact value `1` enables a feature.
 */
export function featureFlagsFromEnv(env: NodeJS.ProcessEnv): FeatureFlags {
  return {
    cloudTelemetry: env[CLOUD_TELEMETRY_FEATURE_ENV] === "1",
    cloudCatalog: env[CLOUD_CATALOG_FEATURE_ENV] === "1",
  };
}

/** Environment entries that an installed daemon service must retain. */
export function featureFlagServiceEnvironment(flags: FeatureFlags): Record<string, string> {
  return {
    ...(flags.cloudTelemetry ? { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } : {}),
    ...(flags.cloudCatalog ? { [CLOUD_CATALOG_FEATURE_ENV]: "1" } : {}),
  };
}

/**
 * Explicit Cloud telemetry override from the invoking environment.
 * `undefined` means the variable is absent and installed service state must
 * be preserved. Any present value is an override: only exact `1` enables.
 */
export function cloudTelemetryOverrideFromEnv(env: NodeJS.ProcessEnv): boolean | undefined {
  if (!Object.hasOwn(env, CLOUD_TELEMETRY_FEATURE_ENV)) return undefined;
  return env[CLOUD_TELEMETRY_FEATURE_ENV] === "1";
}
