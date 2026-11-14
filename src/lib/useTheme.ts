import { useEffect, useState } from "react";
import { usePersistentState } from "./usePersistentState";
import { STORAGE_KEYS } from "./storageKeys";
import {
  applyTheme,
  DEFAULT_THEME,
  resolveTheme,
  sanitizeThemePreference,
  type ResolvedTheme,
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

/**
 * The concrete theme in force (`dark` | `light`), for things that can't use CSS
 * variables: the CodeMirror editor's theme prop and the theme message sent to
 * plugin frames. Re-evaluates when the preference changes and, only while the
 * preference is "system", when the OS setting changes.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [pref] = useThemePreference();
  const [osDark, setOsDark] = useState(systemPrefersDark);
  useEffect(() => {
    if (pref !== "system" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setOsDark(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
  return resolveTheme(pref, osDark);
}
