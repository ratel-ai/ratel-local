import { spawn } from "node:child_process";
import type { SupportedAgentHostKind } from "@ratel-ai/ratel-local-core";

export interface AgentPluginCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type AgentPluginCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<AgentPluginCommandResult>;

export interface AgentPluginInstallResult {
  installed: boolean;
  message: string;
}

export type AgentPluginInstaller = (
  hostKind: SupportedAgentHostKind,
) => Promise<AgentPluginInstallResult>;

export const unavailableAgentPluginInstaller: AgentPluginInstaller = async (hostKind) => ({
  installed: false,
  message: `${hostKind === "codex" ? "Codex" : "Claude Code"} plugin installer is unavailable in this runtime.`,
});

export async function attemptRatelAgentPluginInstall(
  hostKind: SupportedAgentHostKind,
  installPlugin: AgentPluginInstaller,
): Promise<AgentPluginInstallResult> {
  try {
    return await installPlugin(hostKind);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      installed: false,
      message: `${hostKind === "codex" ? "Codex" : "Claude Code"} plugin installation failed: ${detail}`,
    };
  }
}

export async function installRatelAgentPlugin(
  hostKind: SupportedAgentHostKind,
  runCommand: AgentPluginCommandRunner = runAgentPluginCommand,
): Promise<AgentPluginInstallResult> {
  const displayName = hostKind === "codex" ? "Codex" : "Claude Code";
  const command = hostKind === "codex" ? "codex" : "claude";
  const installArgs =
    hostKind === "codex"
      ? ["plugin", "add", "ratel-local@ratel", "--json"]
      : ["plugin", "install", "ratel-local@ratel", "--scope", "user"];
  const installed = await runCommand(command, installArgs);
  if (installed.exitCode === 0) {
    return { installed: true, message: `Ratel Local plugin installed for ${displayName}.` };
  }
  const marketplaceArgs = ["plugin", "marketplace", "add", "ratel-ai/ratel-local"];
  if (hostKind === "codex") marketplaceArgs.push("--json");
  const marketplace = await runCommand(command, marketplaceArgs);
  if (marketplace.exitCode === 0) {
    const retried = await runCommand(command, installArgs);
    if (retried.exitCode === 0) {
      return { installed: true, message: `Ratel Local plugin installed for ${displayName}.` };
    }
    return { installed: false, message: commandFailureMessage(command, retried) };
  }
  return {
    installed: false,
    message: commandFailureMessage(command, marketplace),
  };
}

export function runAgentPluginCommand(
  command: string,
  args: readonly string[],
): Promise<AgentPluginCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function commandFailureMessage(command: string, result: AgentPluginCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return `${command} plugin installation failed: ${detail}`;
}
