import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { platform } from "node:os";

const DEFAULT_API_PORT = 5731;
const DEFAULT_VITE_PORT = 5173;
const HOST = "127.0.0.1";

type ChildName = "api" | "vite";

async function main() {
  const apiPort = await pickPort(Number(process.env.RATEL_LOCAL_UI_API_PORT) || DEFAULT_API_PORT);
  const vitePort = await pickPort(
    Number(process.env.RATEL_LOCAL_UI_VITE_PORT) || DEFAULT_VITE_PORT,
  );

  const children = new Set<ChildProcessWithoutNullStreams>();
  let shuttingDown = false;

  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), 150).unref();
  };

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  const api = run(
    "api",
    [
      "pnpm",
      [
        "--filter",
        "@ratel-ai/ratel-local",
        "exec",
        "tsx",
        "src/bin.ts",
        "ui",
        "--no-open",
        "--port",
        String(apiPort),
      ],
    ],
    children,
    shutdown,
  );

  const token = await waitForUiToken(api, apiPort);
  const apiTarget = `http://${HOST}:${apiPort}`;
  const viteUrl = `http://${HOST}:${vitePort}/?t=${encodeURIComponent(token)}`;

  run(
    "vite",
    [
      "pnpm",
      [
        "--filter",
        "@ratel-ai/ratel-local-ui",
        "exec",
        "vite",
        "--host",
        HOST,
        "--port",
        String(vitePort),
        "--strictPort",
      ],
    ],
    children,
    shutdown,
    { RATEL_LOCAL_API_TARGET: apiTarget },
  );

  console.error("");
  console.error(`[ratel] API target: ${apiTarget}`);
  console.error(`[ratel] Vite UI:    ${viteUrl}`);
  console.error("[ratel] Press Ctrl-C to stop both processes.");

  if (shouldOpenBrowser()) {
    try {
      await waitForPort(vitePort);
      openBrowser(viteUrl);
      console.error(
        "[ratel] Opened the tokenized UI in your browser (set RATEL_LOCAL_UI_OPEN=0 to disable).",
      );
    } catch (err) {
      console.error(`[ratel] Auto-open skipped: ${(err as Error).message}`);
      console.error(`[ratel] Open ${viteUrl} manually.`);
    }
  }
}

function shouldOpenBrowser(): boolean {
  if (process.env.CI) return false;
  const flag = process.env.RATEL_LOCAL_UI_OPEN;
  return flag !== "0" && flag !== "false";
}

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = connect(port, HOST);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`timed out waiting for Vite to listen on port ${port}`));
          return;
        }
        setTimeout(attempt, 200).unref();
      });
    };
    attempt();
  });
}

function openBrowser(url: string): void {
  const [bin, args] =
    platform() === "darwin"
      ? (["open", [url]] as const)
      : platform() === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);

  const child = spawn(bin, [...args], { stdio: "ignore", detached: true });
  child.on("error", () => {
    console.error(`[ratel] Could not auto-open a browser; open ${url} manually.`);
  });
  child.unref();
}

function run(
  name: ChildName,
  command: [string, string[]],
  children: Set<ChildProcessWithoutNullStreams>,
  shutdown: (code?: number) => void,
  env: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const [bin, args] = command;
  const child = spawn(bin, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  children.add(child);
  child.stdout.on("data", (chunk) => writePrefixed(name, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(name, chunk));
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`[ratel] ${name} exited with ${code ?? signal}`);
      shutdown(code ?? 1);
    }
  });

  return child;
}

function waitForUiToken(child: ChildProcessWithoutNullStreams, port: number): Promise<string> {
  const pattern = new RegExp(`http://${HOST}:${port}/\\?t=([^\\s]+)`);
  let buffer = "";

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for ratel-local ui to print its session URL"));
    }, 15_000);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = pattern.exec(buffer);
      if (!match) return;
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.stdout.off("data", onData);
      resolve(match[1]);
    };

    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`ratel-local ui exited before printing a URL: ${code ?? signal}`));
    });
  });
}

async function pickPort(preferred: number): Promise<number> {
  if (await isPortFree(preferred)) return preferred;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate a free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

function writePrefixed(name: ChildName, chunk: Buffer) {
  for (const line of chunk.toString("utf8").split(/\r?\n/)) {
    if (line) console.error(`[${name}] ${line}`);
  }
}

main().catch((err) => {
  console.error(`[ratel] ${(err as Error).message}`);
  process.exit(1);
});
