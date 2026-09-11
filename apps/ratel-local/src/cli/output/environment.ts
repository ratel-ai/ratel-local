export interface OutputEnvironment {
  interactive: boolean;
  color: boolean;
  width: number;
}

interface Terminal {
  isTTY?: boolean;
  columns?: number;
}

export interface OutputEnvironmentInput {
  stdin?: Terminal;
  stdout?: Terminal;
  stderr?: Terminal;
  env?: NodeJS.ProcessEnv;
}

/** Human output uses stderr. Redirecting either output stream selects plain mode. */
export function detectOutputEnvironment(input: OutputEnvironmentInput = {}): OutputEnvironment {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    env = process.env,
  } = input;
  const ci = Boolean(env.CI && !["0", "false"].includes(env.CI.toLowerCase()));
  const terminal = Boolean(stdout.isTTY && stderr.isTTY && !ci && env.TERM !== "dumb");
  const columns = stderr.columns;
  return {
    interactive: terminal && Boolean(stdin.isTTY),
    color: terminal && !env.NO_COLOR && env.FORCE_COLOR !== "0",
    width:
      terminal && columns && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80,
  };
}
