const DISMISS_KEY = "ratel:onboarding-dismissed";

/**
 * The onboarding flow auto-launches while the Ratel config is empty. Once the user
 * skips or finishes, we remember it for the tab session so we don't bounce them back
 * on every reload — they can still re-enter manually via the "Set up agents" action.
 */
export function isOnboardingDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // sessionStorage unavailable (private mode / SSR) — auto-launch stays best-effort.
  }
}
