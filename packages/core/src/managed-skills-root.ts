import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * Canonical, so it matches a target obtained by resolving a live link. A dangling
 * link has no resolved target, and import writes the raw homeDir into it, so a
 * caller comparing a raw readlink must also test the uncanonicalized root.
 */
export async function canonicalManagedSkillsRoot(homeDir: string): Promise<string> {
  const root = join(homeDir, ".ratel", "skills");
  return realpath(root).catch(() => root);
}

export function isInsideManagedRoot(absoluteTarget: string, root: string): boolean {
  return absoluteTarget === root || absoluteTarget.startsWith(`${root}${sep}`);
}
