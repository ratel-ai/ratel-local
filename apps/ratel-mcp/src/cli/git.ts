import { execSync } from "node:child_process";

export function currentGitBranch(): string | null {
  try {
    const out = execSync("git branch --show-current", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}
