/** Expand `${NAME}` placeholders from the daemon environment. Missing values stay visible. */
export function expandEnvPlaceholders(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    return env[name] ?? match;
  });
}
