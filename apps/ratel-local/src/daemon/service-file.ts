/**
 * Feature-flag reconciliation inside an installed launchd or systemd service.
 *
 * `daemon restart` rewrites only the flag entries an operator named explicitly
 * (ADR-0020), never the whole unit: regenerating it from the invoking shell
 * would refresh install-time `PATH` and `RATEL_DAEMON_INSTALL_PATH`, which are
 * preserved so npm/npx cannot reorder agent plugin executables.
 */

const EMPTY_LAUNCH_AGENT_ENV_BLOCK_RE =
  /\n {2}<key>EnvironmentVariables<\/key>\n {2}<dict>\n {2}<\/dict>/;
const LAUNCH_AGENT_ENV_BLOCK_RE =
  /(<key>EnvironmentVariables<\/key>\n {2}<dict>\n)([\s\S]*?)(\n {2}<\/dict>)/;

export const SERVICE_SHAPE_ERROR =
  'installed daemon service is not a Ratel Local unit; reinstall with "ratel-local daemon install"';

/** The flags an operator asked to change, by environment variable name. */
export type ServiceFeatureFlagOverrides = Readonly<Record<string, boolean>>;

const launchAgentEntry = (name: string) => `    <key>${name}</key>\n    <string>1</string>`;
const launchAgentEntryRe = (name: string) =>
  new RegExp(`\\n    <key>${name}</key>\\n    <string>[^<]*</string>`);
const systemdLine = (name: string) => `Environment=${name}=1`;
const systemdLineRe = (name: string) => new RegExp(`^Environment=${name}=.*\\n`, "m");

/**
 * Apply overrides to a launchd plist. Only the named flags move: a flag absent
 * from `overrides` keeps whatever the installed service already says.
 */
export function applyFeatureFlagsToLaunchAgentPlist(
  plist: string,
  overrides: ServiceFeatureFlagOverrides,
): string {
  let next = plist;
  for (const [name, enabled] of Object.entries(overrides)) {
    // Drop the entry, then an environment dict it may have left empty, so the
    // insertion below always sees the shape `createLaunchAgentPlist` emits.
    // Without that, enabling twice appends a dict beside the emptied one.
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

/** The systemd twin: `Environment=` lines immediately above `Restart=always`. */
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
