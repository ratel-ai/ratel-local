import { describe, expect, it } from "vitest";
import {
  advanceAgentImportWorkflow,
  beginAgentImportWorkflow,
  unlinkedAgentImportWarning,
} from "./agent-import-workflow.js";

describe("agent import workflow", () => {
  it("gates an unlinked agent before import and allows linking or skipping", () => {
    const initial = beginAgentImportWorkflow({
      hostKind: "claude-code",
      linked: false,
      statuslineInstalled: false,
    });

    expect(initial.step).toBe("link");
    expect(advanceAgentImportWorkflow(initial, { type: "link-completed" })).toMatchObject({
      step: "import",
      linkDecision: "linked-now",
    });
    expect(advanceAgentImportWorkflow(initial, { type: "link-skipped" })).toMatchObject({
      step: "import",
      linkDecision: "skipped",
    });
  });

  it("starts linked agents at import and offers Claude statusline after completion", () => {
    const initial = beginAgentImportWorkflow({
      hostKind: "claude-code",
      linked: true,
      statuslineInstalled: false,
    });

    expect(initial).toMatchObject({ step: "import", linkDecision: "already-linked" });
    const statusline = advanceAgentImportWorkflow(initial, { type: "import-completed" });
    expect(statusline.step).toBe("statusline");
    expect(advanceAgentImportWorkflow(statusline, { type: "statusline-completed" }).step).toBe(
      "complete",
    );
  });

  it("finishes after import when statusline is irrelevant or already installed", () => {
    const codex = beginAgentImportWorkflow({
      hostKind: "codex",
      linked: true,
      statuslineInstalled: false,
    });
    expect(advanceAgentImportWorkflow(codex, { type: "import-completed" }).step).toBe("complete");

    const claude = beginAgentImportWorkflow({
      hostKind: "claude-code",
      linked: true,
      statuslineInstalled: true,
    });
    expect(advanceAgentImportWorkflow(claude, { type: "import-completed" }).step).toBe("complete");
  });

  it("explains the consequence of importing without linking", () => {
    expect(unlinkedAgentImportWarning("Claude Code")).toMatch(
      /remove the selected MCP entries.*invoke-only.*other linked agents/is,
    );
  });
});
