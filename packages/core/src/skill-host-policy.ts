import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { MutationInputOperation } from "./mutation-engine.js";
import type { DiscoveredSkillSource } from "./skill-discovery.js";

export type NativeSkillSource = Exclude<DiscoveredSkillSource, "ratel">;

export interface SkillHostPolicy {
  mode: "manual-only";
  source: NativeSkillSource;
  previousLine?: string;
  createdFile?: boolean;
  createdPolicy?: boolean;
}

export interface PreparedSkillHostPolicy {
  policy: SkillHostPolicy;
  operation?: MutationInputOperation;
}

export function skillHostPolicyFromLegacyPatch(input: {
  source: NativeSkillSource;
  before?: string;
  created?: boolean;
}): SkillHostPolicy {
  if (input.source === "claude") {
    const previousLine =
      input.before === undefined
        ? undefined
        : frontmatterScalarLine(input.before, "disable-model-invocation");
    return {
      mode: "manual-only",
      source: input.source,
      ...(previousLine === undefined ? {} : { previousLine }),
    };
  }
  const previousLine =
    input.before === undefined
      ? undefined
      : codexPolicyScalarLine(input.before, "allow_implicit_invocation");
  return {
    mode: "manual-only",
    source: input.source,
    ...(previousLine === undefined ? {} : { previousLine }),
    ...(input.created ? { createdFile: true } : {}),
    ...(input.before === undefined || codexPolicyBlockIndex(lines(input.before)) === undefined
      ? { createdPolicy: true }
      : {}),
  };
}

export async function prepareSkillHostPolicy(input: {
  canonicalSkillPath: string;
  homeDir: string;
  id: string;
  source: NativeSkillSource;
}): Promise<PreparedSkillHostPolicy> {
  const skillPath = nativeSkillPath(input.homeDir, input.id, input.source);
  if ((await realpath(skillPath)) !== input.canonicalSkillPath) {
    throw new Error(`native skill path changed before import: ${skillPath}`);
  }
  if (input.source === "claude") {
    const path = join(skillPath, "SKILL.md");
    const before = await readFile(path, "utf8");
    const previousLine = frontmatterScalarLine(before, "disable-model-invocation");
    const after = setFrontmatterScalar(before, "disable-model-invocation", "true");
    return {
      policy: {
        mode: "manual-only",
        source: input.source,
        ...(previousLine === undefined ? {} : { previousLine }),
      },
      ...(after === before ? {} : { operation: { kind: "replace-file", path, contents: after } }),
    };
  }

  const path = join(skillPath, "agents", "openai.yaml");
  let before: string | undefined;
  try {
    before = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previousLine =
    before === undefined ? undefined : codexPolicyScalarLine(before, "allow_implicit_invocation");
  const createdPolicy = before === undefined || codexPolicyBlockIndex(lines(before)) === undefined;
  const after = setCodexManualOnly(before ?? "");
  return {
    policy: {
      mode: "manual-only",
      source: input.source,
      ...(previousLine === undefined ? {} : { previousLine }),
      ...(before === undefined ? { createdFile: true } : {}),
      ...(createdPolicy ? { createdPolicy: true } : {}),
    },
    ...(after === before ? {} : { operation: { kind: "replace-file", path, contents: after } }),
  };
}

export async function prepareSkillHostPolicyRestore(input: {
  homeDir: string;
  id: string;
  policy: SkillHostPolicy;
}): Promise<MutationInputOperation | undefined> {
  const skillPath = nativeSkillPath(input.homeDir, input.id, input.policy.source);
  if (input.policy.source === "claude") {
    const path = join(skillPath, "SKILL.md");
    const before = await readFile(path, "utf8");
    const currentLine = frontmatterScalarLine(before, "disable-model-invocation");
    if (!currentLine || !yamlBooleanLine(currentLine, true)) {
      throw new Error(`Claude skill invocation policy changed outside Ratel: ${path}`);
    }
    const after = restoreFrontmatterScalar(
      before,
      "disable-model-invocation",
      input.policy.previousLine,
    );
    return after === before ? undefined : { kind: "replace-file", path, contents: after };
  }

  const path = join(skillPath, "agents", "openai.yaml");
  const before = await readFile(path, "utf8");
  const currentLine = codexPolicyScalarLine(before, "allow_implicit_invocation");
  if (!currentLine || !yamlBooleanLine(currentLine, false)) {
    throw new Error(`Codex skill invocation policy changed outside Ratel: ${path}`);
  }
  let after = restoreCodexPolicyScalar(
    before,
    "allow_implicit_invocation",
    input.policy.previousLine,
  );
  if (input.policy.createdPolicy) after = removeEmptyCodexPolicy(after);
  if (input.policy.createdFile && after.trim().length === 0) {
    return { kind: "delete-artifact", path };
  }
  return after === before ? undefined : { kind: "replace-file", path, contents: after };
}

function nativeSkillPath(homeDir: string, id: string, source: NativeSkillSource): string {
  if (source === "claude") return join(homeDir, ".claude", "skills", id);
  if (source === "codex-current") return join(homeDir, ".agents", "skills", id);
  return join(homeDir, ".codex", "skills", id);
}

function setFrontmatterScalar(raw: string, key: string, value: string): string {
  const rawLines = lines(raw);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const range = frontmatterRange(rawLines);
  if (!range) throw new Error("SKILL.md is missing valid YAML frontmatter");
  const indexes = scalarIndexes(rawLines, key, range.start + 1, range.end);
  if (indexes.length > 1) throw new Error(`SKILL.md contains duplicate ${key} fields`);
  if (indexes.length === 1) rawLines[indexes[0] as number] = `${key}: ${value}`;
  else rawLines.splice(range.end, 0, `${key}: ${value}`);
  return rawLines.join(newline);
}

function restoreFrontmatterScalar(raw: string, key: string, previousLine: string | undefined) {
  const rawLines = lines(raw);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const range = frontmatterRange(rawLines);
  if (!range) return raw;
  const indexes = scalarIndexes(rawLines, key, range.start + 1, range.end);
  if (indexes.length !== 1) return raw;
  if (previousLine === undefined) rawLines.splice(indexes[0] as number, 1);
  else rawLines[indexes[0] as number] = previousLine;
  return rawLines.join(newline);
}

function frontmatterScalarLine(raw: string, key: string): string | undefined {
  const rawLines = lines(raw);
  const range = frontmatterRange(rawLines);
  if (!range) return undefined;
  const indexes = scalarIndexes(rawLines, key, range.start + 1, range.end);
  return indexes.length === 1 ? rawLines[indexes[0] as number] : undefined;
}

function frontmatterRange(rawLines: string[]): { start: number; end: number } | undefined {
  let start = 0;
  while (start < rawLines.length && rawLines[start]?.trim() === "") start++;
  if (rawLines[start]?.trim() !== "---") return undefined;
  for (let end = start + 1; end < rawLines.length; end++) {
    if (rawLines[end]?.trim() === "---") return { start, end };
  }
  return undefined;
}

function setCodexManualOnly(raw: string): string {
  const rawLines = lines(raw.replace(/\n*$/, ""));
  const policyIndex = codexPolicyBlockIndex(rawLines);
  const allowIndexes = scalarIndexes(rawLines, "allow_implicit_invocation", 0, rawLines.length);
  if (policyIndex === undefined) {
    if (allowIndexes.length > 0) throw new Error("unsupported Codex policy shape");
    const prefix = raw.trim().length === 0 ? "" : `${raw.replace(/\n*$/, "")}\n`;
    return `${prefix}policy:\n  allow_implicit_invocation: false\n`;
  }
  const policyEnd = topLevelBlockEnd(rawLines, policyIndex);
  const indent = policyChildIndent(rawLines.slice(policyIndex + 1, policyEnd));
  const direct = allowIndexes.filter(
    (index) =>
      index > policyIndex &&
      index < policyEnd &&
      (rawLines[index]?.match(/^\s*/)?.[0].length ?? 0) === indent.length,
  );
  if (direct.length !== allowIndexes.length || direct.length > 1) {
    throw new Error("unsupported Codex allow_implicit_invocation placement");
  }
  if (direct.length === 1)
    rawLines[direct[0] as number] = `${indent}allow_implicit_invocation: false`;
  else rawLines.splice(policyEnd, 0, `${indent}allow_implicit_invocation: false`);
  return `${rawLines.join("\n")}\n`;
}

function restoreCodexPolicyScalar(raw: string, key: string, previousLine: string | undefined) {
  const rawLines = lines(raw);
  const policyIndex = codexPolicyBlockIndex(rawLines);
  if (policyIndex === undefined) return raw;
  const end = topLevelBlockEnd(rawLines, policyIndex);
  const indent = policyChildIndent(rawLines.slice(policyIndex + 1, end));
  const indexes = scalarIndexes(rawLines, key, policyIndex + 1, end).filter(
    (index) => (rawLines[index]?.match(/^\s*/)?.[0].length ?? 0) === indent.length,
  );
  if (indexes.length !== 1) return raw;
  if (previousLine === undefined) rawLines.splice(indexes[0] as number, 1);
  else rawLines[indexes[0] as number] = `${indent}${previousLine.trimStart()}`;
  return rawLines.join(raw.includes("\r\n") ? "\r\n" : "\n");
}

function codexPolicyScalarLine(raw: string, key: string): string | undefined {
  const rawLines = lines(raw);
  const policyIndex = codexPolicyBlockIndex(rawLines);
  if (policyIndex === undefined) return undefined;
  const end = topLevelBlockEnd(rawLines, policyIndex);
  const indent = policyChildIndent(rawLines.slice(policyIndex + 1, end));
  const indexes = scalarIndexes(rawLines, key, policyIndex + 1, end).filter(
    (index) => (rawLines[index]?.match(/^\s*/)?.[0].length ?? 0) === indent.length,
  );
  return indexes.length === 1 ? rawLines[indexes[0] as number] : undefined;
}

function removeEmptyCodexPolicy(raw: string): string {
  const rawLines = lines(raw);
  const index = codexPolicyBlockIndex(rawLines);
  if (index === undefined) return raw;
  const end = topLevelBlockEnd(rawLines, index);
  if (rawLines.slice(index + 1, end).some((line) => line.trim().length > 0)) return raw;
  rawLines.splice(index, end - index);
  return rawLines.join(raw.includes("\r\n") ? "\r\n" : "\n");
}

function codexPolicyBlockIndex(rawLines: string[]): number | undefined {
  const indexes = rawLines
    .map((line, index) => (/^policy\s*:\s*(?:#.*)?$/.test(line ?? "") ? index : -1))
    .filter((index) => index >= 0);
  return indexes.length === 1 ? indexes[0] : undefined;
}

function topLevelBlockEnd(rawLines: string[], start: number): number {
  for (let index = start + 1; index < rawLines.length; index++) {
    const line = rawLines[index] ?? "";
    if (line.trim().length > 0 && !/^\s/.test(line)) return index;
  }
  return rawLines.length;
}

function policyChildIndent(children: string[]): string {
  const first = children.find((line) => line.trim().length > 0);
  return first?.match(/^\s+/)?.[0] ?? "  ";
}

function scalarIndexes(rawLines: string[], key: string, start: number, end: number): number[] {
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);
  const indexes: number[] = [];
  for (let index = start; index < end; index++) {
    if (re.test(rawLines[index] ?? "")) indexes.push(index);
  }
  return indexes;
}

function yamlBooleanLine(line: string, value: boolean): boolean {
  return new RegExp(
    `:\\s*(?:${String(value)}|"${String(value)}"|'${String(value)}')\\s*(?:#.*)?$`,
  ).test(line);
}

function lines(raw: string): string[] {
  return raw.split(/\r?\n/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
