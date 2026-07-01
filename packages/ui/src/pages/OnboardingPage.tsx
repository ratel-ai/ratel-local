import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Download, LinkIcon, Sparkles } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { type JsonRequestInit, useRatelApp } from "@/App";
import { AgentIcon, agentDisplayName } from "@/components/agent-identity";
import { RatelBadger } from "@/components/brand-logo";
import { AgentPickCard } from "@/components/onboarding/AgentPickCard";
import { OnboardingLayout } from "@/components/onboarding/OnboardingLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentHostKind,
  agentHostsFromResponse,
  type DetectedAgentHostSummary,
  preferredHostKind,
} from "@/lib/agent-hosts";
import { dismissOnboarding } from "@/lib/onboarding";
import { availableSkillsForKind, type SkillSummary } from "@/lib/skills";
import { AgentOperationPanel, useAvailableSkills } from "@/pages/AgentSetupPage";

type OnboardingStep = "welcome" | "choose" | "setup" | "success";

/**
 * Standalone first-run wizard: welcome → choose an agent → import & link → success.
 * Reuses the agent import/link machinery (`AgentOperationPanel`) so setup behaves exactly
 * like the Agent Setup page, wrapped in a focused, dedicated flow.
 */
export function OnboardingPage() {
  const { available, reload: reloadSkills } = useAvailableSkills();
  const { request, token } = useRatelApp();
  const navigate = useNavigate();
  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [hosts, setHosts] = useState<DetectedAgentHostSummary[]>([]);
  const [selectedKind, setSelectedKind] = useState<AgentHostKind | null>(null);

  const scanHosts = useCallback(async () => {
    try {
      setHosts(agentHostsFromResponse(await request<unknown>("/api/agent-hosts")));
    } catch {
      setHosts([]);
    }
  }, [request]);

  useEffect(() => {
    void scanHosts();
  }, [scanHosts]);

  useEffect(() => {
    setSelectedKind((current) => current ?? (hosts.length > 0 ? preferredHostKind(hosts) : null));
  }, [hosts]);

  const goToDashboard = useCallback(() => {
    dismissOnboarding();
    void navigate({ to: token ? `/?t=${encodeURIComponent(token)}` : "/" } as never);
  }, [navigate, token]);

  const selectedHost = hosts.find((host) => host.kind === selectedKind) ?? null;
  const agentSkills = selectedKind ? availableSkillsForKind(available, selectedKind) : [];

  if (step === "welcome") {
    return (
      <OnboardingLayout onSkip={goToDashboard}>
        <WelcomeStep onStart={() => setStep("choose")} />
      </OnboardingLayout>
    );
  }

  if (step === "choose") {
    return (
      <OnboardingLayout onSkip={goToDashboard} progress={{ current: 0, total: 3 }}>
        <ChooseAgentStep
          available={available}
          hosts={hosts}
          onBack={() => setStep("welcome")}
          onContinue={() => setStep("setup")}
          onSelect={setSelectedKind}
          selectedKind={selectedKind}
        />
      </OnboardingLayout>
    );
  }

  if (step === "setup") {
    return (
      <OnboardingLayout onSkip={goToDashboard} progress={{ current: 1, total: 3 }}>
        <SetupStep
          availableSkills={agentSkills}
          host={selectedHost}
          onApplied={() => setStep("success")}
          onBack={() => setStep("choose")}
          onContinue={() => setStep("success")}
          onScanHosts={scanHosts}
          onSkillsImported={reloadSkills}
          request={request}
        />
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout progress={{ current: 2, total: 3 }}>
      <SuccessStep
        host={selectedHost}
        onAnother={() => {
          setSelectedKind(null);
          setStep("choose");
          void scanHosts();
        }}
        onDashboard={goToDashboard}
      />
    </OnboardingLayout>
  );
}

function WelcomeStep(props: { onStart: () => void }) {
  return (
    <div className="grid gap-8 text-center">
      <div className="grid gap-4">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-border bg-card/40">
          <RatelBadger className="h-[22px] w-[48px] bg-brand-green dark:bg-brand-cream" />
        </div>
        <div className="grid gap-2">
          <h1 className="text-balance font-semibold text-3xl tracking-tight">Welcome to Ratel</h1>
          <p className="mx-auto max-w-md text-balance text-muted-foreground">
            Ratel is a context-engineering gateway for your coding agents. Route their MCP tools and
            skills through one place — import what you already have to get started.
          </p>
        </div>
      </div>
      <ul className="mx-auto grid max-w-md gap-3 text-left">
        <FeatureRow
          description="Pull existing servers from Claude Code or Codex into Ratel."
          icon={<Download className="size-4" />}
          title="Import MCP tools"
        />
        <FeatureRow
          description="Serve agent skills through the gateway, native invoke intact."
          icon={<Sparkles className="size-4" />}
          title="Manage skills"
        />
        <FeatureRow
          description="Link an agent so every tool call is routed through Ratel."
          icon={<LinkIcon className="size-4" />}
          title="One gateway"
        />
      </ul>
      <div className="flex justify-center">
        <Button onClick={props.onStart} size="lg" type="button">
          Get started
          <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function FeatureRow(props: { description: string; icon: ReactNode; title: string }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-card/40 text-muted-foreground">
        {props.icon}
      </span>
      <div>
        <p className="font-medium text-sm">{props.title}</p>
        <p className="text-muted-foreground text-sm">{props.description}</p>
      </div>
    </li>
  );
}

function ChooseAgentStep(props: {
  available: SkillSummary[];
  hosts: DetectedAgentHostSummary[];
  onBack: () => void;
  onContinue: () => void;
  onSelect: (kind: AgentHostKind) => void;
  selectedKind: AgentHostKind | null;
}) {
  const loading = props.hosts.length === 0;
  return (
    <div className="grid gap-6">
      <StepHeading
        description="Pick the agent you want to route through Ratel. We'll import its MCP tools and skills next."
        title="Choose an agent to set up"
      />
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {props.hosts.map((host) => (
            <AgentPickCard
              host={host}
              key={host.kind}
              onSelect={() => props.onSelect(host.kind)}
              selected={props.selectedKind === host.kind}
              unmanagedSkillCount={availableSkillsForKind(props.available, host.kind).length}
            />
          ))}
        </div>
      )}
      <StepFooter
        onBack={props.onBack}
        primary={
          <Button disabled={!props.selectedKind} onClick={props.onContinue} type="button">
            Continue
            <ArrowRight />
          </Button>
        }
      />
    </div>
  );
}

function SetupStep(props: {
  availableSkills: SkillSummary[];
  host: DetectedAgentHostSummary | null;
  onApplied: () => void;
  onBack: () => void;
  onContinue: () => void;
  onScanHosts: () => Promise<void>;
  onSkillsImported: () => void | Promise<void>;
  request: <T>(path: string, init?: JsonRequestInit) => Promise<T>;
}) {
  if (!props.host) {
    return (
      <div className="grid gap-6">
        <StepHeading description="Loading the agent configuration…" title="Set up your agent" />
      </div>
    );
  }
  const name = props.host.displayName ?? agentDisplayName(props.host.kind);
  return (
    <div className="grid gap-6">
      <StepHeading
        description="Import unmanaged MCP tools and skills, or link the Ratel gateway. Every change is previewed before anything is written."
        icon={<AgentIcon kind={props.host.kind} />}
        title={`Set up ${name}`}
      />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="px-4 sm:px-6">
          <AgentOperationPanel
            availableSkills={props.availableSkills}
            host={props.host}
            hostKind={props.host.kind}
            onApplied={props.onApplied}
            onScanHosts={props.onScanHosts}
            onSkillsImported={props.onSkillsImported}
            request={props.request}
          />
        </div>
      </div>
      <StepFooter
        onBack={props.onBack}
        primary={
          <Button onClick={props.onContinue} type="button" variant="outline">
            Continue
            <ArrowRight />
          </Button>
        }
      />
    </div>
  );
}

function SuccessStep(props: {
  host: DetectedAgentHostSummary | null;
  onAnother: () => void;
  onDashboard: () => void;
}) {
  const name = props.host
    ? (props.host.displayName ?? agentDisplayName(props.host.kind))
    : "your agent";
  const ratelCount = props.host?.ratelEntryCount ?? 0;
  return (
    <div className="grid gap-8 text-center">
      <div className="grid gap-4">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-emerald-400/40 bg-emerald-500/10 text-emerald-500">
          <Check className="size-7" />
        </div>
        <div className="grid gap-2">
          <h1 className="font-semibold text-3xl tracking-tight">You're all set</h1>
          <p className="mx-auto max-w-md text-balance text-muted-foreground">
            {ratelCount > 0
              ? `Ratel is now routing ${ratelCount} MCP ${ratelCount === 1 ? "entry" : "entries"} for ${name}.`
              : `${name} is ready. You can import tools and skills anytime from Agent Setup.`}
          </p>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center gap-2 sm:flex-row">
        <Button onClick={props.onDashboard} size="lg" type="button">
          Go to dashboard
          <ArrowRight />
        </Button>
        <Button onClick={props.onAnother} size="lg" type="button" variant="ghost">
          Set up another agent
        </Button>
      </div>
    </div>
  );
}

function StepHeading(props: { description: string; icon?: ReactNode; title: string }) {
  return (
    <div className="grid gap-2">
      {props.icon ? <div className="mb-2 flex">{props.icon}</div> : null}
      <h1 className="font-semibold text-2xl tracking-tight">{props.title}</h1>
      <p className="text-muted-foreground text-sm">{props.description}</p>
    </div>
  );
}

function StepFooter(props: { onBack: () => void; primary: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Button onClick={props.onBack} type="button" variant="ghost">
        <ArrowLeft />
        Back
      </Button>
      {props.primary}
    </div>
  );
}
