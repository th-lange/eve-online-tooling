import { useEffect } from "react";
import { usePersistentState } from "./usePersistentState";
import { STORAGE_KEYS } from "./storageKeys";
import {
  applyTheme,
  DEFAULT_THEME,
  resolveTheme,
  sanitizeThemePreference,
  systemPrefersDark,
  type ThemePreference,
} from "./theme";

/**
 * The persisted appearance preference. Safe to call from several components:
 * `usePersistentState` keeps every instance of one key in sync (#1191), so the
 * Settings control and the root `ThemeApplier` always agree.
 */
export function useThemePreference(): [
  ThemePreference,
  (t: ThemePreference) => void,
] {
  const [stored, setStored] = usePersistentState<ThemePreference>(
    STORAGE_KEYS.theme,
    DEFAULT_THEME,
  );
  return [sanitizeThemePreference(stored), setStored];
}

/**
 * Keeps `<html data-theme>` in step with the preference, and — only while the
 * preference is "system" — with the OS setting as it changes. Mount once, at
 * the app root.
 */
export function useApplyTheme(): void {
  const [pref] = useThemePreference();
  useEffect(() => {
    applyTheme(resolveTheme(pref, systemPrefersDark()));
    if (pref !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(resolveTheme(pref, mq.matches));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
}
