import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { createCliOutput } from "./index.js";

function capture(interactive = false, width = 80, color = interactive) {
  const lines: string[] = [];
  const output = createCliOutput({
    environment: { interactive, color, width },
    write: (line) => lines.push(line),
  });
  return { lines, output };
}

describe("CLI rendering", () => {
  it("prints readable labels and strips terminal escapes from plain output", () => {
    const { output, lines } = capture();
    output.success("Saved");
    output.warning("Needs restart");
    output.error("Missing file");
    output.heading("Projects");
    output.list(["one", "\u001b[31mtwo\u001b[0m"]);
    expect(lines).toEqual([
      "[ok] Saved",
      "[warning] Needs restart",
      "[error] Missing file",
      "Projects",
      "- one",
      "- two",
    ]);
  });

  it("adds color only when enabled", () => {
    const rich = capture(true);
    rich.output.success("Saved");
    expect(rich.lines[0]).not.toBe(stripVTControlCharacters(rich.lines[0]));
    const uncolored = capture(true, 80, false);
    uncolored.output.success("Saved");
    expect(uncolored.lines).toEqual(["[ok] Saved"]);
  });

  it("preserves full cell values in plain tables independent of terminal width", () => {
    const { output, lines } = capture(false, 10);
    output.table(["Name", "Path"], [["api", "/very/long/project/path"]]);
    expect(lines).toEqual(["Name\tPath", "api\t/very/long/project/path"]);
  });

  it("uses labelled records when a terminal table cannot fit", () => {
    const { output, lines } = capture(true, 25, false);
    output.table(["Name", "Path"], [["api", "/very/long/project/path"]]);
    expect(lines.join("\n")).toContain("Name: api");
    expect(lines.join("\n")).toContain("Path: /very/long/project/path");
  });

  it("aligns terminal tables and escapes tabs and newlines inside cells", () => {
    const { output, lines } = capture(true, 80, false);
    output.table(
      ["Name", "State"],
      [
        ["api", "ready"],
        ["a\nb", "x\ty"],
      ],
    );
    expect(lines).toEqual(["Name  State", "api   ready", "a\\nb  x\\ty"]);
  });

  it("aligns wide Unicode and combining characters by terminal cells", () => {
    const { output, lines } = capture(true, 80, false);
    output.table(
      ["Name", "State"],
      [
        ["日本", "ready"],
        ["e\u0301", "ready"],
      ],
    );
    expect(lines).toEqual(["Name  State", "日本  ready", "e\u0301     ready"]);
  });
});
