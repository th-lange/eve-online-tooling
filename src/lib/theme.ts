// Appearance preference (#1213). The user picks System / Dark / Light; that is
// resolved to a concrete `dark | light` and applied as `data-theme` on <html>
// (plus `color-scheme`, so native controls and scrollbars match). Default is
// **dark**, so nobody's UI changes on upgrade.
//
// `public/theme-init.js` applies the same thing before first paint; keep the
// two in step (theme.test.ts evaluates that file against this logic).

export const THEME_PREFERENCES = ["system", "dark", "light"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "dark" | "light";

export const DEFAULT_THEME: ThemePreference = "dark";

export function isThemePreference(v: unknown): v is ThemePreference {
  return (
    typeof v === "string" &&
    (THEME_PREFERENCES as readonly string[]).includes(v)
  );
}

/** A stored value that isn't a known preference (hand-edited, future) → default. */
export function sanitizeThemePreference(v: unknown): ThemePreference {
  return isThemePreference(v) ? v : DEFAULT_THEME;
}

export function resolveTheme(
  pref: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

/** Whether the OS asks for dark. No `matchMedia` (tests) → dark, the default. */
export function systemPrefersDark(): boolean {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}
