export interface SkillDocumentEdit {
  description: string;
  tags: string[];
  body: string;
}

/**
 * Rewrite the author-owned fields while retaining unknown frontmatter keys and
 * comments. `triggers` is folded into tags, matching the runtime skill model.
 */
export function rewriteSkillDocument(raw: string, next: SkillDocumentEdit): string {
  const lines = raw.split(/\r?\n/);
  let open = 0;
  while (open < lines.length && lines[open]?.trim() === "") open += 1;
  let close = -1;
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      close = index;
      break;
    }
  }
  const descriptionLine = `description: ${JSON.stringify(next.description)}`;
  const tagsLine =
    next.tags.length > 0
      ? `tags: [${next.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`
      : null;

  if (lines[open]?.trim() !== "---" || close === -1) {
    return [
      "---",
      descriptionLine,
      ...(tagsLine ? [tagsLine] : []),
      "---",
      "",
      next.body.trim(),
      "",
    ].join("\n");
  }

  const frontmatter: string[] = [];
  let descriptionWritten = false;
  let tagsWritten = false;
  for (let index = open + 1; index < close; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      frontmatter.push(line);
      continue;
    }
    const separator = line.indexOf(":");
    const key = separator === -1 ? "" : line.slice(0, separator).trim();
    const isBlockKey = separator !== -1 && line.slice(separator + 1).trim() === "";
    const skipBlockList = () => {
      while (index + 1 < close && /^\s*-\s+/.test(lines[index + 1] ?? "")) index += 1;
    };
    if (key === "description") {
      if (!descriptionWritten) {
        frontmatter.push(descriptionLine);
        descriptionWritten = true;
      }
      if (isBlockKey) skipBlockList();
      continue;
    }
    if (key === "tags" || key === "triggers") {
      if (!tagsWritten) {
        if (tagsLine) frontmatter.push(tagsLine);
        tagsWritten = true;
      }
      if (isBlockKey) skipBlockList();
      continue;
    }
    frontmatter.push(line);
  }
  if (!descriptionWritten) frontmatter.push(descriptionLine);
  if (!tagsWritten && tagsLine) frontmatter.push(tagsLine);

  const normalizedFrontmatter = frontmatter.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return ["---", normalizedFrontmatter, "---", "", next.body.trim(), ""].join("\n");
}

/** Remove the generated resource index before persisting an editor round-trip. */
export function stripBundledResourceIndex(body: string): string {
  return body.replace(BUNDLED_RESOURCES_BLOCK, "").trimEnd();
}

const BUNDLED_RESOURCES_BLOCK = /\n\n---\n\n## Bundled resources \(absolute paths\)\n[\s\S]*$/;
