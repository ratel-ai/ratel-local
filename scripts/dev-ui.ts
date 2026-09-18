import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const HOST = "127.0.0.1";
const DEFAULT_VITE_PORT = 5173;

const exec = promisify(execFile);

async function main() {
  const session = await daemonUiSession();
  const vitePort = Number(process.env.RATEL_LOCAL_UI_VITE_PORT) || DEFAULT_VITE_PORT;
  const uiPath = `${session.pathname}${session.search}`;

  const args = [
    "--filter",
    "@ratel-ai/ratel-local-ui",
    "exec",
    "vite",
    "--host",
    HOST,
    "--port",
    String(vitePort),
    "--strictPort",
  ];
  if (shouldOpenBrowser()) args.push("--open", uiPath);

  console.error("");
  console.error(`[ratel] API target: ${session.origin}`);
  console.error(`[ratel] Vite UI:    http://${HOST}:${vitePort}${uiPath}`);
  console.error("[ratel] Press Ctrl-C to stop.");

  const vite = spawn("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, RATEL_LOCAL_API_TARGET: session.origin },
  });
  vite.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

/** Asks the running daemon for a UI session; its URL carries both the proxy target and the token. */
async function daemonUiSession(): Promise<URL> {
  const { stdout, stderr } = await exec("pnpm", [
    "--filter",
    "@ratel-ai/ratel-local",
    "exec",
    "tsx",
    "src/bin.ts",
    "ui",
    "--no-open",
  ]);
  const match = /https?:\/\/\S+\?t=\S+/.exec(`${stdout}\n${stderr}`);
  if (!match) throw new Error("`ratel-local ui --no-open` printed no session URL");
  return new URL(match[0]);
}

function shouldOpenBrowser(): boolean {
  if (process.env.CI) return false;
  const flag = process.env.RATEL_LOCAL_UI_OPEN;
  return flag !== "0" && flag !== "false";
}

main().catch((err) => {
  const stderr = (err as { stderr?: string }).stderr?.trim();
  console.error(stderr || `[ratel] ${(err as Error).message}`);
  process.exit(1);
});
