import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextDiagnostics, type SnapshotDiagnostic } from "./context-diagnostics";

const warning = (code: string, message: string): SnapshotDiagnostic => ({
  code,
  severity: "warning",
  message,
});

describe("ContextDiagnostics", () => {
  it("renders nothing when the context is healthy", () => {
    expect(renderToStaticMarkup(<ContextDiagnostics diagnostics={[]} />)).toBe("");
  });

  it("shows the message and the code, so a warning can be acted on and searched for", () => {
    const html = renderToStaticMarkup(
      <ContextDiagnostics
        diagnostics={[
          warning(
            "cloud-skill-shadowed",
            'Cloud skill "shared" is not in use: a local skill with the same id takes precedence.',
          ),
        ]}
      />,
    );

    expect(html).toContain("cloud-skill-shadowed");
    expect(html).toContain("a local skill with the same id takes precedence");
  });

  it("puts errors above warnings", () => {
    const html = renderToStaticMarkup(
      <ContextDiagnostics
        diagnostics={[
          warning("cloud-catalog-degraded", "serving a cached catalog"),
          { code: "project-control-path-unsafe", severity: "error", message: "outside the root" },
        ]}
      />,
    );

    expect(html.indexOf("outside the root")).toBeLessThan(html.indexOf("serving a cached catalog"));
  });

  it("marks an error apart from a warning instead of showing both the same", () => {
    const asError = renderToStaticMarkup(
      <ContextDiagnostics diagnostics={[{ code: "boom", severity: "error", message: "broken" }]} />,
    );
    const asWarning = renderToStaticMarkup(
      <ContextDiagnostics diagnostics={[warning("boom", "broken")]} />,
    );

    expect(asError).toContain("text-destructive");
    expect(asWarning).not.toContain("text-destructive");
  });

  it("shows the path when the diagnostic names one", () => {
    const html = renderToStaticMarkup(
      <ContextDiagnostics
        diagnostics={[{ ...warning("skill-unreadable", "cannot read"), path: "/a/b/SKILL.md" }]}
      />,
    );

    expect(html).toContain("/a/b/SKILL.md");
  });
});
