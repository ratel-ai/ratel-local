import { homedir } from "node:os";
import { join } from "node:path";

export type SkillSource = "claude" | "codex";

export interface SkillPaths {
  nativeDir: string;
  codexDir: string;
  managedDir: string;
}

export function defaultSkillPaths(home: string = homedir()): SkillPaths {
  return {
    nativeDir: join(home, ".claude", "skills"),
    codexDir: join(home, ".codex", "skills"),
    managedDir: join(home, ".ratel", "skills"),
  };
}
