import { describe, expect, it } from "vitest";
import {
  createLaunchAgentPlist,
  createSystemdUserService,
  DEFAULT_DAEMON_PORT,
} from "../cli/handlers/daemon.js";
import { CLOUD_CATALOG_FEATURE_ENV, CLOUD_TELEMETRY_FEATURE_ENV } from "../feature-flags.js";
import {
  applyFeatureFlagsToLaunchAgentPlist,
  applyFeatureFlagsToSystemdUserService,
} from "./service-file.js";

const HOME = "/Users/tester";
const base = {
  executablePath: "/opt/bin/ratel-local",
  homeDir: HOME,
  port: DEFAULT_DAEMON_PORT,
};

describe("service file feature flags", () => {
  // Without `pathEnv` the flag is the only environment entry, so enabling has to
  // create the dict from scratch and disabling has to remove it again. That is
  // the shape an install performs when PATH is unset in its environment.
  for (const pathEnv of ["/opt/node/bin:/usr/bin:/bin", undefined]) {
    it(`round-trips against generated service files (pathEnv: ${pathEnv ? "set" : "unset"})`, () => {
      const input = { ...base, ...(pathEnv ? { pathEnv } : {}) };
      const on = { [CLOUD_TELEMETRY_FEATURE_ENV]: true };
      const off = { [CLOUD_TELEMETRY_FEATURE_ENV]: false };

      const disabledPlist = createLaunchAgentPlist({
        ...input,
        featureFlags: { cloudTelemetry: false, cloudCatalog: false },
      });
      const enabledPlist = createLaunchAgentPlist({
        ...input,
        featureFlags: { cloudTelemetry: true, cloudCatalog: false },
      });
      expect(applyFeatureFlagsToLaunchAgentPlist(disabledPlist, on)).toBe(enabledPlist);
      expect(applyFeatureFlagsToLaunchAgentPlist(enabledPlist, off)).toBe(disabledPlist);
      expect(applyFeatureFlagsToLaunchAgentPlist(enabledPlist, on)).toBe(enabledPlist);
      expect(applyFeatureFlagsToLaunchAgentPlist(disabledPlist, off)).toBe(disabledPlist);

      const disabledUnit = createSystemdUserService({
        ...input,
        featureFlags: { cloudTelemetry: false, cloudCatalog: false },
      });
      const enabledUnit = createSystemdUserService({
        ...input,
        featureFlags: { cloudTelemetry: true, cloudCatalog: false },
      });
      expect(applyFeatureFlagsToSystemdUserService(disabledUnit, on)).toBe(enabledUnit);
      expect(applyFeatureFlagsToSystemdUserService(enabledUnit, off)).toBe(disabledUnit);
      expect(applyFeatureFlagsToSystemdUserService(enabledUnit, on)).toBe(enabledUnit);
      expect(applyFeatureFlagsToSystemdUserService(disabledUnit, off)).toBe(disabledUnit);
    });
  }

  it("moves one flag without disturbing another", () => {
    // A flag left out of the overrides keeps whatever the service already says,
    // so enabling the catalog can never silently switch telemetry off.
    const both = createLaunchAgentPlist({
      ...base,
      pathEnv: "/usr/bin",
      featureFlags: { cloudTelemetry: true, cloudCatalog: true },
    });
    const withoutCatalog = applyFeatureFlagsToLaunchAgentPlist(both, {
      [CLOUD_CATALOG_FEATURE_ENV]: false,
    });
    expect(withoutCatalog).toContain(CLOUD_TELEMETRY_FEATURE_ENV);
    expect(withoutCatalog).not.toContain(CLOUD_CATALOG_FEATURE_ENV);

    const unit = createSystemdUserService({
      ...base,
      pathEnv: "/usr/bin",
      featureFlags: { cloudTelemetry: true, cloudCatalog: true },
    });
    const unitWithoutTelemetry = applyFeatureFlagsToSystemdUserService(unit, {
      [CLOUD_TELEMETRY_FEATURE_ENV]: false,
    });
    expect(unitWithoutTelemetry).toContain(CLOUD_CATALOG_FEATURE_ENV);
    expect(unitWithoutTelemetry).not.toContain(`${CLOUD_TELEMETRY_FEATURE_ENV}=`);
  });

  it("refuses to enable a flag in an unrecognised service file", () => {
    const on = { [CLOUD_TELEMETRY_FEATURE_ENV]: true };
    const off = { [CLOUD_TELEMETRY_FEATURE_ENV]: false };
    expect(() => applyFeatureFlagsToLaunchAgentPlist("<plist />", on)).toThrow(
      /not a Ratel Local unit/,
    );
    expect(() => applyFeatureFlagsToSystemdUserService("[Service]\n", on)).toThrow(
      /not a Ratel Local unit/,
    );
    // Disabling stays a no-op there: there is no Ratel route to remove.
    expect(applyFeatureFlagsToLaunchAgentPlist("<plist />", off)).toBe("<plist />");
    expect(applyFeatureFlagsToSystemdUserService("[Service]\n", off)).toBe("[Service]\n");
  });
});
