import type { ServiceFeatureFlagOverrides } from "../feature-flags.js";

const EMPTY_LAUNCH_AGENT_ENV_BLOCK_RE =
  /\n {2}<key>EnvironmentVariables<\/key>\n {2}<dict>\n {2}<\/dict>/;
const LAUNCH_AGENT_ENV_BLOCK_RE =
  /(<key>EnvironmentVariables<\/key>\n {2}<dict>\n)([\s\S]*?)(\n {2}<\/dict>)/;

export const SERVICE_SHAPE_ERROR =
  'installed daemon service is not a Ratel Local unit; reinstall with "ratel-local daemon install"';

// Rewrite the installed unit rather than regenerate it: regenerating refreshes
// install-time PATH, which ADR-0020 preserves so npx can't reorder plugin binaries.
export function applyFeatureFlagsToLaunchAgentPlist(
  plist: string,
  overrides: ServiceFeatureFlagOverrides,
): string {
  let next = plist;
  for (const [name, enabled] of Object.entries(overrides)) {
    // Drop the entry, then an environment dict it may have left empty. Both
    // branches below assume the shape `createLaunchAgentPlist` emits: without the
    // second replace, enabling twice appends a new dict beside the emptied one.
    const stripped = next.replace(launchAgentEntryRe(name), "");
    next = stripped.replace(EMPTY_LAUNCH_AGENT_ENV_BLOCK_RE, "");
    if (!enabled) continue;
    const block = LAUNCH_AGENT_ENV_BLOCK_RE.exec(next);
    if (block?.index !== undefined) {
      const inserted = `${block[1]}${block[2]}\n${launchAgentEntry(name)}${block[3]}`;
      next = next.slice(0, block.index) + inserted + next.slice(block.index + block[0].length);
      continue;
    }
    if (!next.includes("<key>StandardOutPath</key>")) throw new Error(SERVICE_SHAPE_ERROR);
    next = next.replace(
      "  <key>StandardOutPath</key>",
      `  <key>EnvironmentVariables</key>\n  <dict>\n${launchAgentEntry(name)}\n  </dict>\n  <key>StandardOutPath</key>`,
    );
  }
  return next;
}

export function applyFeatureFlagsToSystemdUserService(
  unit: string,
  overrides: ServiceFeatureFlagOverrides,
): string {
  let next = unit;
  for (const [name, enabled] of Object.entries(overrides)) {
    next = next.replace(systemdLineRe(name), "");
    if (!enabled) continue;
    if (!next.includes("Restart=always")) throw new Error(SERVICE_SHAPE_ERROR);
    next = next.replace("Restart=always", `${systemdLine(name)}\nRestart=always`);
  }
  return next;
}

function launchAgentEntry(name: string): string {
  return `    <key>${name}</key>\n    <string>1</string>`;
}

function launchAgentEntryRe(name: string): RegExp {
  return new RegExp(`\\n    <key>${name}</key>\\n    <string>[^<]*</string>`);
}

function systemdLine(name: string): string {
  return `Environment=${name}=1`;
}

function systemdLineRe(name: string): RegExp {
  return new RegExp(`^Environment=${name}=.*\\n`, "m");
}
