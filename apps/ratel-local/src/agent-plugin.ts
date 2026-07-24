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
  pluginAvailable?: boolean;
  message: string;
}

export interface AgentPluginInstallRequest {
  reconcileMarketplace?: boolean;
}

export type AgentPluginInstaller = (
  hostKind: SupportedAgentHostKind,
  request?: AgentPluginInstallRequest,
) => Promise<AgentPluginInstallResult>;

export const unavailableAgentPluginInstaller: AgentPluginInstaller = async (hostKind) => ({
  installed: false,
  message: `${hostKind === "codex" ? "Codex" : "Claude Code"} plugin installer is unavailable in this runtime.`,
});

export async function attemptRatelAgentPluginInstall(
  hostKind: SupportedAgentHostKind,
  installPlugin: AgentPluginInstaller,
  request?: AgentPluginInstallRequest,
): Promise<AgentPluginInstallResult> {
  try {
    return await installPlugin(hostKind, request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      installed: false,
      message: `${hostKind === "codex" ? "Codex" : "Claude Code"} plugin installation failed: ${detail}`,
    };
  }
}

export interface RatelAgentPluginInstallerOptions {
  packageVersion?: string;
  runCommand?: AgentPluginCommandRunner;
}

interface InstallRatelAgentPluginOptions extends AgentPluginInstallRequest {
  packageVersion?: string;
}

const RATEL_MARKETPLACE_NAME = "ratel";
const RATEL_MARKETPLACE_SOURCE = "ratel-ai/ratel-local";
const RATEL_MARKETPLACE_GIT_URL = "https://github.com/ratel-ai/ratel-local.git";
const RATEL_PLUGIN_ID = "ratel-local@ratel";

export function createRatelAgentPluginInstaller(
  options: RatelAgentPluginInstallerOptions = {},
): AgentPluginInstaller {
  const runCommand = options.runCommand ?? runAgentPluginCommand;
  return (hostKind, request) =>
    installRatelAgentPlugin(hostKind, runCommand, {
      packageVersion: options.packageVersion,
      ...request,
    });
}

export async function installRatelAgentPlugin(
  hostKind: SupportedAgentHostKind,
  runCommand: AgentPluginCommandRunner = runAgentPluginCommand,
  options: InstallRatelAgentPluginOptions = {},
): Promise<AgentPluginInstallResult> {
  const displayName = hostKind === "codex" ? "Codex" : "Claude Code";
  const command = hostKind === "codex" ? "codex" : "claude";
  const installArgs = pluginInstallArgs(hostKind);
  const marketplaceRef = ratelMarketplaceRefForVersion(options.packageVersion);

  if (marketplaceRef) {
    const refAvailable = await runCommand("git", [
      "ls-remote",
      "--exit-code",
      RATEL_MARKETPLACE_GIT_URL,
      `refs/tags/${marketplaceRef}`,
    ]);
    if (refAvailable.exitCode !== 0) {
      return {
        installed: false,
        pluginAvailable: options.reconcileMarketplace || undefined,
        message: `Could not verify Ratel marketplace ref ${marketplaceRef}: ${failureDetail(refAvailable)}. ${
          options.reconcileMarketplace
            ? "Existing plugin installation was left unchanged."
            : "No plugin changes were made."
        }`,
      };
    }

    if (options.reconcileMarketplace) {
      return switchMarketplaceAndInstall(
        hostKind,
        command,
        displayName,
        installArgs,
        marketplaceRef,
        runCommand,
        true,
      );
    }

    const marketplace = await runCommand(command, marketplaceAddArgs(hostKind, marketplaceRef));
    if (marketplace.exitCode === 0) {
      return installFromConfiguredMarketplace(
        hostKind,
        command,
        displayName,
        installArgs,
        marketplaceRef,
        runCommand,
        false,
      );
    }
    if (!isMarketplaceAlreadyConfigured(marketplace)) {
      return {
        installed: false,
        message: commandFailureMessage(command, marketplace),
      };
    }
    return switchMarketplaceAndInstall(
      hostKind,
      command,
      displayName,
      installArgs,
      marketplaceRef,
      runCommand,
      false,
    );
  }

  if (options.reconcileMarketplace) {
    return switchMarketplaceAndInstall(
      hostKind,
      command,
      displayName,
      installArgs,
      undefined,
      runCommand,
      true,
    );
  }

  const installed = await runCommand(command, installArgs);
  if (installed.exitCode === 0) {
    return { installed: true, message: `Ratel Local plugin installed for ${displayName}.` };
  }
  const marketplace = await runCommand(command, marketplaceAddArgs(hostKind));
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

export function ratelMarketplaceRefForVersion(packageVersion?: string): string | undefined {
  const version = packageVersion?.trim();
  if (
    !version ||
    !/^\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    return undefined;
  }
  return `v${version}`;
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

async function switchMarketplaceAndInstall(
  hostKind: SupportedAgentHostKind,
  command: string,
  displayName: string,
  installArgs: readonly string[],
  marketplaceRef: string | undefined,
  runCommand: AgentPluginCommandRunner,
  existingPlugin: boolean,
): Promise<AgentPluginInstallResult> {
  const removed = await runCommand(command, marketplaceRemoveArgs());
  if (removed.exitCode !== 0 && !isMarketplaceMissing(removed)) {
    return {
      installed: false,
      pluginAvailable: existingPlugin || undefined,
      message: `${commandFailureMessage(command, removed)} ${
        existingPlugin
          ? "Existing plugin installation was left unchanged."
          : "No plugin changes were made."
      }`,
    };
  }

  const marketplace = await runCommand(command, marketplaceAddArgs(hostKind, marketplaceRef));
  if (marketplace.exitCode !== 0) {
    return marketplaceRef
      ? restoreStablePlugin(
          hostKind,
          command,
          displayName,
          installArgs,
          commandFailureMessage(command, marketplace),
          runCommand,
        )
      : {
          installed: false,
          pluginAvailable: existingPlugin ? false : undefined,
          message: commandFailureMessage(command, marketplace),
        };
  }

  return installFromConfiguredMarketplace(
    hostKind,
    command,
    displayName,
    installArgs,
    marketplaceRef,
    runCommand,
    existingPlugin,
  );
}

async function installFromConfiguredMarketplace(
  hostKind: SupportedAgentHostKind,
  command: string,
  displayName: string,
  installArgs: readonly string[],
  marketplaceRef: string | undefined,
  runCommand: AgentPluginCommandRunner,
  pluginUnavailableOnFailure: boolean,
): Promise<AgentPluginInstallResult> {
  const installed = await runCommand(command, installArgs);
  if (installed.exitCode === 0) {
    return {
      installed: true,
      message: marketplaceRef
        ? `Ratel Local plugin installed for ${displayName} from ${marketplaceRef}.`
        : `Ratel Local plugin installed for ${displayName}.`,
    };
  }
  return marketplaceRef
    ? restoreStablePlugin(
        hostKind,
        command,
        displayName,
        installArgs,
        commandFailureMessage(command, installed),
        runCommand,
      )
    : {
        installed: false,
        pluginAvailable: pluginUnavailableOnFailure ? false : undefined,
        message: commandFailureMessage(command, installed),
      };
}

async function restoreStablePlugin(
  hostKind: SupportedAgentHostKind,
  command: string,
  displayName: string,
  installArgs: readonly string[],
  targetFailure: string,
  runCommand: AgentPluginCommandRunner,
): Promise<AgentPluginInstallResult> {
  const removed = await runCommand(command, marketplaceRemoveArgs());
  if (removed.exitCode !== 0 && !isMarketplaceMissing(removed)) {
    return {
      installed: false,
      pluginAvailable: false,
      message: `${targetFailure} Stable plugin restoration also failed: ${failureDetail(removed)}.`,
    };
  }
  const marketplace = await runCommand(command, marketplaceAddArgs(hostKind));
  if (marketplace.exitCode !== 0) {
    return {
      installed: false,
      pluginAvailable: false,
      message: `${targetFailure} Stable plugin restoration also failed: ${failureDetail(marketplace)}.`,
    };
  }
  const installed = await runCommand(command, installArgs);
  if (installed.exitCode !== 0) {
    return {
      installed: false,
      pluginAvailable: false,
      message: `${targetFailure} Stable plugin restoration also failed: ${failureDetail(installed)}.`,
    };
  }
  return {
    installed: false,
    pluginAvailable: true,
    message: `${targetFailure} Restored the stable Ratel Local plugin for ${displayName}; the requested release-candidate channel is not active.`,
  };
}

function pluginInstallArgs(hostKind: SupportedAgentHostKind): string[] {
  return hostKind === "codex"
    ? ["plugin", "add", RATEL_PLUGIN_ID, "--json"]
    : ["plugin", "install", RATEL_PLUGIN_ID, "--scope", "user"];
}

function marketplaceAddArgs(hostKind: SupportedAgentHostKind, marketplaceRef?: string): string[] {
  if (hostKind === "codex") {
    return [
      "plugin",
      "marketplace",
      "add",
      RATEL_MARKETPLACE_SOURCE,
      ...(marketplaceRef ? ["--ref", marketplaceRef] : []),
      "--json",
    ];
  }
  return [
    "plugin",
    "marketplace",
    "add",
    marketplaceRef ? `${RATEL_MARKETPLACE_SOURCE}@${marketplaceRef}` : RATEL_MARKETPLACE_SOURCE,
  ];
}

function marketplaceRemoveArgs(): string[] {
  return ["plugin", "marketplace", "remove", RATEL_MARKETPLACE_NAME];
}

function isMarketplaceAlreadyConfigured(result: AgentPluginCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    detail.includes("marketplace") &&
    (detail.includes("already added") ||
      detail.includes("already exists") ||
      detail.includes("already configured") ||
      detail.includes("already installed") ||
      detail.includes("already known") ||
      detail.includes("different source"))
  );
}

function isMarketplaceMissing(result: AgentPluginCommandResult): boolean {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    detail.includes("marketplace") &&
    (detail.includes("not found") ||
      detail.includes("no marketplace") ||
      detail.includes("does not exist") ||
      detail.includes("isn't configured") ||
      detail.includes("is not configured") ||
      detail.includes("unknown marketplace"))
  );
}

function commandFailureMessage(command: string, result: AgentPluginCommandResult): string {
  return `${command} plugin installation failed: ${failureDetail(result)}`;
}

function failureDetail(result: AgentPluginCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
}
