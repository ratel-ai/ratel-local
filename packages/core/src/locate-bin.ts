import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface LocateBinEnv {
  envVar?: string;
  whichResult?: string;
  workspaceRoot?: string;
  exists?: (path: string) => Promise<boolean>;
  promptForPath?: () => Promise<string>;
}

export interface ResolvedBin {
  command: string;
  args: string[];
  source: "env" | "path" | "workspace" | "prompt";
}

const WORKSPACE_BIN_REL = join("dist", "bin.js");

export async function locateRatelBin(env: LocateBinEnv): Promise<ResolvedBin> {
  if (env.envVar && env.envVar.length > 0) {
    return { command: env.envVar, args: [], source: "env" };
  }
  if (env.whichResult && env.whichResult.length > 0) {
    return { command: env.whichResult, args: [], source: "path" };
  }
  if (env.workspaceRoot) {
    const path = join(env.workspaceRoot, WORKSPACE_BIN_REL);
    const ok = env.exists ? await env.exists(path) : true;
    if (ok) {
      return { command: "node", args: [path], source: "workspace" };
    }
  }
  if (env.promptForPath) {
    const v = (await env.promptForPath()).trim();
    if (v) {
      return { command: resolve(v), args: [], source: "prompt" };
    }
  }
  throw new Error(
    "Could not locate the ratel binary. Set $RATEL_LOCAL_BIN or run from inside the ratel-local workspace.",
  );
}

export function whichRatelBin(): string | undefined {
  // Look up the alias, not `ratel`: that generic name can belong to an unrelated tool.
  try {
    const out = execSync("which ratel-local", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out ? primaryRatelBin(out) : undefined;
  } catch {
    return undefined;
  }
}

/** Swap a `ratel-local` link for the `ratel` link installed beside it by the same package. */
export function primaryRatelBin(
  path: string,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): string {
  if (basename(path) !== "ratel-local") return path;
  const primary = join(dirname(path), "ratel");
  return isExecutable(primary) ? primary : path;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
