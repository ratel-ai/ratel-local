export type AgentImportHostKind = "claude-code" | "codex";

export type AgentImportLinkDecision = "already-linked" | "linked-now" | "skipped";

interface AgentImportWorkflowContext {
  hostKind: AgentImportHostKind;
  linkDecision: AgentImportLinkDecision | null;
  statuslineInstalled: boolean;
}

export type AgentImportWorkflowState = AgentImportWorkflowContext &
  ({ step: "link" } | { step: "import" } | { step: "statusline" } | { step: "complete" });

export type AgentImportWorkflowEvent =
  | { type: "link-completed" }
  | { type: "link-skipped" }
  | { type: "import-completed" }
  | { type: "statusline-completed" };

export function beginAgentImportWorkflow(input: {
  hostKind: AgentImportHostKind;
  linked: boolean;
  statuslineInstalled: boolean;
}): AgentImportWorkflowState {
  return {
    step: input.linked ? "import" : "link",
    hostKind: input.hostKind,
    linkDecision: input.linked ? "already-linked" : null,
    statuslineInstalled: input.statuslineInstalled,
  };
}

export function advanceAgentImportWorkflow(
  state: AgentImportWorkflowState,
  event: AgentImportWorkflowEvent,
): AgentImportWorkflowState {
  if (state.step === "link") {
    if (event.type === "link-completed") {
      return { ...state, step: "import", linkDecision: "linked-now" };
    }
    if (event.type === "link-skipped") {
      return { ...state, step: "import", linkDecision: "skipped" };
    }
  }
  if (state.step === "import" && event.type === "import-completed") {
    const shouldOfferStatusline = state.hostKind === "claude-code" && !state.statuslineInstalled;
    return { ...state, step: shouldOfferStatusline ? "statusline" : "complete" };
  }
  if (state.step === "statusline" && event.type === "statusline-completed") {
    return { ...state, step: "complete", statuslineInstalled: true };
  }
  throw new Error(`invalid agent import workflow transition: ${state.step} + ${event.type}`);
}

export function unlinkedAgentImportWarning(agentDisplayName: string): string {
  return `${agentDisplayName} is not linked to Ratel. Importing will remove the selected MCP entries and make the selected skills invoke-only in ${agentDisplayName}. Without linking, they will no longer be usable there, but they will remain available through Ratel for other linked agents.`;
}
