import type { Dirent } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

/** Directory entries may be real directories or symlinks/junctions to directories. */
export async function isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}
