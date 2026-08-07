type UiFeatureEnvironment = Record<string, string | boolean | undefined>;

export function agentSettingsPageEnabled(
  environment: UiFeatureEnvironment = import.meta.env,
): boolean {
  const value = environment.VITE_RATEL_AGENT_SETTINGS;
  return value === "1" || value === "true";
}
