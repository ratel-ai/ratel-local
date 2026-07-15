import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { DocumentRevision } from "./context.js";
import { isPlainObject } from "./json.js";
import type { MutationInputOperation } from "./mutation-engine.js";
import { validateCopySourceDirectory } from "./mutation-engine.js";

export interface AdoptedSkillCopy {
  path: string;
  revision: DocumentRevision;
  markerPath?: string;
}

export interface SkillCopyMaterializationPlan {
  operations: MutationInputOperation[];
  adopted?: AdoptedSkillCopy;
}

export class SkillCopyAdoptionError extends Error {
  readonly statusCode = 422;
  readonly code = "SKILL_COPY_ADOPTION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SkillCopyAdoptionError";
  }
}

/**
 * Plan either a fresh validated directory copy or explicit adoption of the
 * exact source directory already occupying its derived copy path.
 */
export async function planSkillCopyMaterialization(input: {
  sourcePath: string;
  targetPath: string;
  id: string;
}): Promise<SkillCopyMaterializationPlan> {
  const sourcePath = await realpath(input.sourcePath);
  await validateCopySourceDirectory(sourcePath);
  const marker = await inspectMarker(sourcePath, input.id);

  let targetInfo: Stats;
  try {
    targetInfo = await lstat(input.targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      operations: [
        {
          kind: "copy-directory",
          sourcePath,
          path: input.targetPath,
          additionalFiles:
            marker === "missing"
              ? [
                  {
                    relativePath: ".ratel-skill.json",
                    contents: ownershipMarkerContents(input.id),
                  },
                ]
              : [],
        },
      ],
    };
  }

  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new SkillCopyAdoptionError(`copy target is not a real directory: ${input.targetPath}`);
  }
  const canonicalTarget = await realpath(input.targetPath);
  if (canonicalTarget !== sourcePath) {
    throw new SkillCopyAdoptionError(
      `copy target already exists and is not the selected source: ${input.targetPath}`,
    );
  }
  const revision = await validateCopySourceDirectory(canonicalTarget);
  const markerPath = join(canonicalTarget, ".ratel-skill.json");
  return {
    operations:
      marker === "missing"
        ? [
            {
              kind: "replace-file",
              path: markerPath,
              contents: ownershipMarkerContents(input.id),
            },
          ]
        : [],
    adopted: {
      path: canonicalTarget,
      revision,
      ...(marker === "missing" ? { markerPath } : {}),
    },
  };
}

async function inspectMarker(path: string, id: string): Promise<"missing" | "matching"> {
  const markerPath = join(path, ".ratel-skill.json");
  let info: Stats;
  try {
    info = await lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SkillCopyAdoptionError(`source has an unsafe ownership marker: ${path}`);
  }
  let marker: unknown;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw new SkillCopyAdoptionError(`source has an invalid ownership marker: ${path}`);
  }
  if (!isPlainObject(marker) || marker.version !== 1 || marker.id !== id) {
    throw new SkillCopyAdoptionError(`source has an invalid ownership marker: ${path}`);
  }
  return "matching";
}

function ownershipMarkerContents(id: string): string {
  return `${JSON.stringify({ version: 1, id }, null, 2)}\n`;
}
