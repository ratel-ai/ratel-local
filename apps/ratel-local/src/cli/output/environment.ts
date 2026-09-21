export interface OutputEnvironment {
  interactive: boolean;
  /** Questions read stdin and draw on stderr, so a redirected stdout does not block them. */
  prompt: boolean;
  color: boolean;
  width: number;
}

export const PLAIN: OutputEnvironment = {
  interactive: false,
  prompt: false,
  color: false,
  width: 80,
};

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
    prompt: Boolean(stdin.isTTY && stderr.isTTY && !ci),
    color: terminal && !env.NO_COLOR && env.FORCE_COLOR !== "0",
    width:
      terminal && columns && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80,
  };
}
