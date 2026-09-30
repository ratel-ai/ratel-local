/** The new Skill filesystem and host behavior. Opt-in: only the exact value "1" enables it. */
export const SKILL_STORAGE_FEATURE_ENV = "RATEL_FEATURE_SKILL_STORAGE";

export function skillStorageEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKILL_STORAGE_FEATURE_ENV] === "1";
}
