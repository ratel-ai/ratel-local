import { describe, expect, it } from "vitest";
import { agentSettingsPageEnabled } from "./ui-features";

describe("agent settings UI flag", () => {
  it("ships off by default and accepts the explicit dev opt-in", () => {
    expect(agentSettingsPageEnabled({})).toBe(false);
    expect(agentSettingsPageEnabled({ VITE_RATEL_AGENT_SETTINGS: "1" })).toBe(true);
    expect(agentSettingsPageEnabled({ VITE_RATEL_AGENT_SETTINGS: "true" })).toBe(true);
  });
});
