export type PrimaryDestination = "/" | "/skills" | "/clients" | "/settings";
export type ShortcutPlatform = "mac" | "other";

export const COMMAND_MENU_SHORTCUT = {
  hotkey: "Mod+K",
  label: "Open command menu",
} as const;

export const REFRESH_SHORTCUT = {
  hotkey: "Mod+R",
  label: "Refresh current view",
} as const;

export function currentShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "other";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "mac" : "other";
}

export function formatShortcutChord(chord: string, platform: ShortcutPlatform): string {
  return chord
    .split("+")
    .map((key) => {
      if (key === "Mod") return platform === "mac" ? "⌘" : "Ctrl";
      return key;
    })
    .join(" ");
}
