import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/** Links are compared against the canonical root: a symlinked home would otherwise never match. */
export async function canonicalManagedSkillsRoot(homeDir: string): Promise<string> {
  const root = join(homeDir, ".ratel", "skills");
  return realpath(root).catch(() => root);
}

export function isInsideManagedRoot(absoluteTarget: string, root: string): boolean {
  return absoluteTarget === root || absoluteTarget.startsWith(`${root}${sep}`);
}
