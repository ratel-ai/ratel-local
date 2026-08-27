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

/** Every daemon-wide flag an installed service may carry. */
export const SERVICE_FEATURE_FLAG_ENVS = [
  CLOUD_TELEMETRY_FEATURE_ENV,
  CLOUD_CATALOG_FEATURE_ENV,
] as const;

/**
 * The flags an operator named explicitly, by presence in the environment. A
 * flag left out keeps whatever the installed service already says, so changing
 * one never disturbs another (ADR-0020, ADR-0021).
 */
export function featureFlagOverridesFromEnv(
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, boolean>> {
  const overrides: Record<string, boolean> = {};
  for (const name of SERVICE_FEATURE_FLAG_ENVS) {
    if (Object.hasOwn(env, name)) overrides[name] = env[name] === "1";
  }
  return overrides;
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
