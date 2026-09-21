import { stripVTControlCharacters } from "node:util";
import stringWidth from "fast-string-width";
import type { OutputEnvironment } from "./environment.js";

export type MessageLevel = "ok" | "info" | "warning" | "error";
const colors: Record<MessageLevel, number> = { ok: 32, info: 36, warning: 33, error: 31 };

export function style(text: string, code: number, color: boolean): string {
  const clean = stripVTControlCharacters(text);
  return color ? `\u001b[${code}m${clean}\u001b[0m` : clean;
}

export function renderMessage(level: MessageLevel, message: string, color: boolean): string {
  return `${style(`[${level}]`, colors[level], color)} ${stripVTControlCharacters(message)}`;
}

function cell(value: string): string {
  return stripVTControlCharacters(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
}

/** Plain tables keep complete values. Narrow terminals fall back to labelled records. */
export function renderTable(
  columns: string[],
  rows: string[][],
  environment: OutputEnvironment,
): string[] {
  const values = [columns, ...rows].map((row) => row.map(cell));
  if (!environment.interactive) return values.map((row) => row.join("\t"));

  const widths = columns.map((_, index) =>
    values.reduce((max, row) => Math.max(max, stringWidth(row[index])), 0),
  );
  if (
    widths.reduce((sum, width) => sum + width, 0) + (columns.length - 1) * 2 >
    environment.width
  ) {
    return values
      .slice(1)
      .flatMap((row, rowIndex) => [
        ...(rowIndex ? [""] : []),
        ...row.map((value, index) => `${style(values[0][index], 1, environment.color)}: ${value}`),
      ]);
  }
  return values.map((row, rowIndex) => {
    const line = row
      .map(
        (value, index) =>
          value + (index === row.length - 1 ? "" : " ".repeat(widths[index] - stringWidth(value))),
      )
      .join("  ");
    return rowIndex === 0 ? style(line, 1, environment.color) : line;
  });
}
