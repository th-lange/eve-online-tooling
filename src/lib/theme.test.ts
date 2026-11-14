import { beforeEach, describe, expect, it } from "vitest";
import themeInitSrc from "../../public/theme-init.js?raw";
import {
  applyTheme,
  resolveTheme,
  sanitizeThemePreference,
  type ThemePreference,
} from "./theme";

describe("theme resolution", () => {
  it("resolves explicit choices and follows the OS only for 'system'", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("falls back to dark for anything that isn't a known preference", () => {
    expect(sanitizeThemePreference("light")).toBe("light");
    expect(sanitizeThemePreference("sepia")).toBe("dark");
    expect(sanitizeThemePreference(null)).toBe("dark");
    expect(sanitizeThemePreference(42)).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("sets data-theme and color-scheme on <html>", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

// public/theme-init.js runs before first paint and duplicates the resolution
// logic; run the real file against the real resolveTheme so they can't drift.
describe("public/theme-init.js", () => {
  const src = themeInitSrc;
  const run = (stored: string | null, osDark: boolean) => {
    localStorage.clear();
    if (stored !== null) localStorage.setItem("settings.theme", stored);
    document.documentElement.removeAttribute("data-theme");
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: osDark,
    });
    new Function(src)();
    return document.documentElement.getAttribute("data-theme");
  };

  beforeEach(() => localStorage.clear());

  it("defaults to dark with nothing stored, and ignores garbage", () => {
    expect(run(null, false)).toBe("dark");
    expect(run("not json", false)).toBe("dark");
    expect(run('"sepia"', false)).toBe("dark");
  });

  it("agrees with resolveTheme for every preference and OS setting", () => {
    for (const pref of ["system", "dark", "light"] as ThemePreference[]) {
      for (const osDark of [true, false]) {
        expect(run(JSON.stringify(pref), osDark)).toBe(
          resolveTheme(pref, osDark),
        );
      }
    }
  });
});
