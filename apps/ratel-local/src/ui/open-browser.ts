import { spawn } from "node:child_process";

export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  spawnFn?: typeof spawn;
}

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const spawner = deps.spawnFn ?? spawn;

  let cmd: string;
  let args: string[];
  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  const child = spawner(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Browser open failed; the URL is still printed to the terminal.
  });
  child.unref();
}
