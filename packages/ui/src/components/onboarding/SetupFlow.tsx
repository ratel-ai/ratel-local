import { ArrowRight, Download, Gauge, LinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type JsonRequestInit, useRatelApp } from "@/App";
import { AgentIcon, agentDisplayName } from "@/components/agent-identity";
import {
  OnboardingLayout,
  StepFooter,
  StepHeading,
} from "@/components/onboarding/OnboardingLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type DetectedAgentHostSummary, missingRatelEntryNames } from "@/lib/agent-hosts";
import type { SkillSummary } from "@/lib/skills";
import {
  type AgentPlanPreview,
  ImportConflictsScene,
  ImportEntriesScene,
  ImportReviewScene,
  type ImportScene,
  ImportSkillsScene,
  ImportStrategyScene,
  LinkReviewScene,
  useAgentApply,
  useImportDraft,
} from "@/pages/AgentSetupPage";

/**
 * Guided, first-class version of the agent import/link flow for onboarding. Instead of the
 * Agent Setup page's dialog, each scene (skills → tools → conflicts → review) becomes its
 * own onboarding step, followed — for Claude Code — by an optional statusline step. Reuses
 * the exact state machine (`useImportDraft`), apply sequence (`useAgentApply`), and scene
 * bodies from `AgentSetupPage`, so behavior matches the dialog.
 */

// All setup sub-steps sit under the middle "set up" dot; success is the third.
const SETUP_PROGRESS = { current: 1, total: 3 };

const SCENE_COPY: Record<ImportScene, { description: string; kicker: string; title: string }> = {
  skills: {
    description: "Select which agent skills Ratel should serve through the gateway.",
    kicker: "Skills",
    title: "Choose skills to manage",
  },
  entries: {
    description: "Pick the MCP servers to pull into Ratel.",
    kicker: "Tools",
    title: "Choose tools to import",
  },
  strategy: {
    description: "Some names already exist in Ratel. Choose how to handle them.",
    kicker: "Conflicts",
    title: "Resolve matching names",
  },
  "pick-conflicts": {
    description: "Selected entries overwrite the Ratel version; the rest keep the current one.",
    kicker: "Conflicts",
    title: "Pick agent versions",
  },
  review: {
    description: "Confirm the config changes before applying.",
    kicker: "Review",
    title: "Review changes",
  },
};

function agentName(host: DetectedAgentHostSummary) {
  return host.displayName ?? agentDisplayName(host.kind);
}

export function SetupFlow(props: {
  availableSkills: SkillSummary[];
  host: DetectedAgentHostSummary;
  onBack: () => void;
  onDone: () => void;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  onSkip: () => void;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const apply = useAgentApply({
    hostKind: props.host.kind,
    onScanHosts: props.onScanHosts,
    onSkillsImported: props.onSkillsImported,
    request: props.request,
  });
  const [preview, setPreview] = useState<AgentPlanPreview | null>(null);
  const [phase, setPhase] = useState<"flow" | "statusline">("flow");

  const canImport =
    missingRatelEntryNames(props.host).length > 0 || props.availableSkills.length > 0;
  const canLink = props.host.posture !== "unavailable" && props.host.ratelEntryCount === 0;
  const needsStatusline =
    props.host.kind === "claude-code" &&
    props.host.statusline != null &&
    !props.host.statusline.installed;

  useEffect(() => {
    if (!canImport && !canLink) return;
    let cancelled = false;
    const load = async () => {
      const endpoint = canImport ? "/api/agent-preview/import" : "/api/agent-preview/link";
      try {
        const body = await props.request<AgentPlanPreview>(endpoint, {
          method: "POST",
          body: { hostKind: props.host.kind },
        });
        if (!cancelled) setPreview(body);
      } catch {
        if (!cancelled) setPreview(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [canImport, canLink, props.host.kind, props.request]);

  const finish = () => {
    if (needsStatusline) setPhase("statusline");
    else props.onDone();
  };

  if (phase === "statusline") {
    return (
      <OnboardingLayout onSkip={props.onSkip} progress={SETUP_PROGRESS}>
        <StatuslineStep
          host={props.host}
          onDone={props.onDone}
          onScanHosts={props.onScanHosts}
          request={props.request}
        />
      </OnboardingLayout>
    );
  }

  if (!canImport && !canLink) {
    return (
      <OnboardingLayout onSkip={props.onSkip} progress={SETUP_PROGRESS}>
        <NothingToDoStep host={props.host} onBack={props.onBack} onContinue={finish} />
      </OnboardingLayout>
    );
  }

  if (!preview) {
    return (
      <OnboardingLayout onSkip={props.onSkip} progress={SETUP_PROGRESS}>
        <div className="grid gap-6">
          <StepHeading
            description="Reading the agent configuration…"
            kicker="Set up"
            title={`Set up ${agentName(props.host)}`}
          />
          <div className="grid gap-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-10 rounded-lg" />
          </div>
        </div>
      </OnboardingLayout>
    );
  }

  if (canImport) {
    return (
      <ImportSteps
        host={props.host}
        onApplied={finish}
        onBack={props.onBack}
        onCommit={apply.commitImport}
        onSkip={props.onSkip}
        preview={preview}
        request={props.request}
        skills={props.availableSkills}
      />
    );
  }

  return (
    <LinkStep
      host={props.host}
      onApplied={finish}
      onBack={props.onBack}
      onCommit={() => apply.commitLink(preview)}
      onSkip={props.onSkip}
      preview={preview}
    />
  );
}

function ImportSteps(props: {
  host: DetectedAgentHostSummary;
  onApplied: () => void;
  onBack: () => void;
  onCommit: ReturnType<typeof useAgentApply>["commitImport"];
  onSkip: () => void;
  preview: AgentPlanPreview;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
  skills: SkillSummary[];
}) {
  const draft = useImportDraft({
    active: true,
    hostKind: props.host.kind,
    preview: props.preview,
    request: props.request,
    skills: props.skills,
  });
  const [scene, setScene] = useState<ImportScene>(draft.activeScenes[0] ?? "review");
  const [committing, setCommitting] = useState(false);

  const scenes = draft.activeScenes;
  const currentScene = scenes.includes(scene) ? scene : (scenes[0] ?? "review");
  const index = scenes.indexOf(currentScene);
  const isReview = currentScene === "review";

  const goNext = () => {
    const next = scenes[index + 1];
    if (next) setScene(next);
  };
  const goBack = () => {
    const prev = scenes[index - 1];
    if (prev) setScene(prev);
    else props.onBack();
  };

  const canContinue =
    currentScene === "skills"
      ? draft.canLeaveSkills
      : currentScene === "entries"
        ? draft.hasSelectedImport
        : true;

  const commit = async () => {
    setCommitting(true);
    try {
      const ok = await props.onCommit(
        draft.draftPreview,
        draft.conflictStrategy,
        draft.replaceConflicts,
        draft.selectedSkills,
      );
      if (ok) props.onApplied();
    } finally {
      setCommitting(false);
    }
  };

  const copy = SCENE_COPY[currentScene];
  const sceneBody =
    currentScene === "skills" ? (
      <ImportSkillsScene
        onToggle={draft.toggleSkill}
        onToggleAll={draft.toggleSkills}
        resetKey={`onboarding:${props.host.kind}`}
        selected={draft.draftSkillSelection}
        skills={props.skills}
      />
    ) : currentScene === "entries" ? (
      <ImportEntriesScene
        candidates={props.preview.candidates}
        onToggle={draft.toggleEntry}
        selected={draft.selected}
      />
    ) : currentScene === "strategy" ? (
      <ImportStrategyScene onChange={draft.setConflictStrategy} strategy={draft.conflictStrategy} />
    ) : currentScene === "pick-conflicts" ? (
      <ImportConflictsScene
        conflicts={draft.conflicts}
        onToggleReplace={draft.toggleReplaceConflict}
        replaceConflicts={new Set(draft.replaceConflicts)}
      />
    ) : (
      <ImportReviewScene
        hostDisplayName={props.host.displayName}
        preview={draft.draftPreview}
        selectedSkills={draft.selectedSkills}
      />
    );

  return (
    <OnboardingLayout onSkip={props.onSkip} progress={SETUP_PROGRESS}>
      <div className="grid gap-6">
        <StepHeading
          description={copy.description}
          icon={index === 0 ? <AgentIcon kind={props.host.kind} /> : undefined}
          kicker={copy.kicker}
          title={copy.title}
        />
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="px-4 py-4 sm:px-5">{sceneBody}</div>
        </div>
        <StepFooter
          onBack={goBack}
          primary={
            isReview ? (
              <Button
                disabled={committing || !draft.hasSelectedImport}
                onClick={() => void commit()}
                type="button"
              >
                <Download />
                Import
              </Button>
            ) : (
              <Button disabled={!canContinue} onClick={goNext} type="button">
                Continue
                <ArrowRight />
              </Button>
            )
          }
        />
      </div>
    </OnboardingLayout>
  );
}

function LinkStep(props: {
  host: DetectedAgentHostSummary;
  onApplied: () => void;
  onBack: () => void;
  onCommit: () => Promise<boolean>;
  onSkip: () => void;
  preview: AgentPlanPreview;
}) {
  const [committing, setCommitting] = useState(false);
  const commit = async () => {
    setCommitting(true);
    try {
      const ok = await props.onCommit();
      if (ok) props.onApplied();
    } finally {
      setCommitting(false);
    }
  };
  return (
    <OnboardingLayout onSkip={props.onSkip} progress={SETUP_PROGRESS}>
      <div className="grid gap-6">
        <StepHeading
          description="Add the Ratel gateway to this agent so its tool calls route through Ratel."
          icon={<AgentIcon kind={props.host.kind} />}
          kicker="Link"
          title={`Link ${agentName(props.host)}`}
        />
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="px-4 py-4 sm:px-5">
            <LinkReviewScene preview={props.preview} />
          </div>
        </div>
        <StepFooter
          onBack={props.onBack}
          primary={
            <Button disabled={committing} onClick={() => void commit()} type="button">
              <LinkIcon />
              Link
            </Button>
          }
        />
      </div>
    </OnboardingLayout>
  );
}

function StatuslineStep(props: {
  host: DetectedAgentHostSummary;
  onDone: () => void;
  onScanHosts: () => Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  const { runAction } = useRatelApp();
  const [busy, setBusy] = useState(false);
  const state = props.host.statusline;
  const otherConfigured = state?.status === "other";

  const install = async () => {
    setBusy(true);
    try {
      const ok = await runAction(
        otherConfigured ? "Statusline replaced" : "Statusline installed",
        () =>
          props.request("/api/claude-statusline/install", {
            method: "POST",
            body: { force: otherConfigured },
          }),
      );
      if (ok) {
        await props.onScanHosts();
        props.onDone();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 text-center">
      <div className="grid gap-4">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-border bg-card/40 text-muted-foreground">
          <Gauge className="size-7" />
        </div>
        <div className="grid gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">Add the Ratel statusline?</h1>
          <p className="mx-auto max-w-md text-balance text-muted-foreground text-sm">
            Show model, context-window usage, whether Ratel is enabled, and the tool tokens Ratel
            keeps out of Claude's prompt — right in Claude Code's statusline.
          </p>
          {state && !state.ratelEnabled ? (
            <p className="mx-auto max-w-md text-amber-700 text-xs dark:text-amber-400">
              Ratel isn't enabled in Claude Code yet, so the statusline will report that until the
              gateway is linked.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col items-center justify-center gap-2 sm:flex-row">
        <Button disabled={busy} onClick={() => void install()} size="lg" type="button">
          <Gauge />
          {otherConfigured ? "Replace statusline" : "Install statusline"}
        </Button>
        <Button onClick={props.onDone} size="lg" type="button" variant="ghost">
          Skip for now
        </Button>
      </div>
    </div>
  );
}

function NothingToDoStep(props: {
  host: DetectedAgentHostSummary;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="grid gap-6">
      <StepHeading
        description="This agent is already linked and every tool and skill is managed by Ratel. Nothing to import."
        icon={<AgentIcon kind={props.host.kind} />}
        kicker="Set up"
        title={`${agentName(props.host)} is ready`}
      />
      <StepFooter
        onBack={props.onBack}
        primary={
          <Button onClick={props.onContinue} type="button">
            Continue
            <ArrowRight />
          </Button>
        }
      />
    </div>
  );
}
