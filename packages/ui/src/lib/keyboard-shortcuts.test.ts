import { describe, expect, it } from "vitest";
import { COMMAND_MENU_SHORTCUT, formatShortcutChord } from "./keyboard-shortcuts";

describe("keyboard shortcuts", () => {
  it("formats the command-menu chord for the current platform", () => {
    expect(COMMAND_MENU_SHORTCUT.hotkey).toBe("Mod+K");
    expect(formatShortcutChord(COMMAND_MENU_SHORTCUT.hotkey, "mac")).toBe("⌘ K");
    expect(formatShortcutChord(COMMAND_MENU_SHORTCUT.hotkey, "other")).toBe("Ctrl K");
  });
});
