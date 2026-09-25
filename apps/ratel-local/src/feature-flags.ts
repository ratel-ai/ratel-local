export const ADAPTIVE_RANKING_FEATURE_ENV = "RATEL_FEATURE_ADAPTIVE_RANKING";
export const CLOUD_TELEMETRY_FEATURE_ENV = "RATEL_FEATURE_CLOUD_TELEMETRY";
export const CLOUD_CATALOG_FEATURE_ENV = "RATEL_FEATURE_CLOUD_CATALOG";
export const SKILL_STORAGE_FEATURE_ENV = "RATEL_FEATURE_SKILL_STORAGE";

/** Every daemon-wide flag an installed service may carry. */
export const SERVICE_FEATURE_FLAG_ENVS = [
  ADAPTIVE_RANKING_FEATURE_ENV,
  CLOUD_TELEMETRY_FEATURE_ENV,
  CLOUD_CATALOG_FEATURE_ENV,
  SKILL_STORAGE_FEATURE_ENV,
] as const;

export interface FeatureFlags {
  adaptiveRanking: boolean;
  cloudTelemetry: boolean;
  cloudCatalog: boolean;
  skillStorage: boolean;
}

/** The flags an operator named explicitly, keyed by environment variable. */
export type ServiceFeatureFlagOverrides = Readonly<
  Partial<Record<(typeof SERVICE_FEATURE_FLAG_ENVS)[number], boolean>>
>;

/**
 * Resolve daemon-wide feature flags from the startup environment. Flags are
 * deliberately opt-in: only the exact value `1` enables a feature.
 */
export function featureFlagsFromEnv(env: NodeJS.ProcessEnv): FeatureFlags {
  return {
    adaptiveRanking: env[ADAPTIVE_RANKING_FEATURE_ENV] === "1",
    cloudTelemetry: env[CLOUD_TELEMETRY_FEATURE_ENV] === "1",
    cloudCatalog: env[CLOUD_CATALOG_FEATURE_ENV] === "1",
    skillStorage: env[SKILL_STORAGE_FEATURE_ENV] === "1",
  };
}

/** Only enabled flags reach the service file; absence means off. */
export function featureFlagServiceEnvironment(
  flags: Partial<FeatureFlags>,
): Record<string, string> {
  return {
    ...(flags.adaptiveRanking ? { [ADAPTIVE_RANKING_FEATURE_ENV]: "1" } : {}),
    ...(flags.cloudTelemetry ? { [CLOUD_TELEMETRY_FEATURE_ENV]: "1" } : {}),
    ...(flags.cloudCatalog ? { [CLOUD_CATALOG_FEATURE_ENV]: "1" } : {}),
    ...(flags.skillStorage ? { [SKILL_STORAGE_FEATURE_ENV]: "1" } : {}),
  };
}

/**
 * Explicit feature-flag overrides from the invoking environment.
 * A flag left out keeps installed service state. Any present value is an
 * override: only exact `1` enables.
 */
export function featureFlagOverridesFromEnv(env: NodeJS.ProcessEnv): ServiceFeatureFlagOverrides {
  const overrides: Partial<Record<(typeof SERVICE_FEATURE_FLAG_ENVS)[number], boolean>> = {};
  for (const name of SERVICE_FEATURE_FLAG_ENVS) {
    if (Object.hasOwn(env, name)) overrides[name] = env[name] === "1";
  }
  return overrides;
}
