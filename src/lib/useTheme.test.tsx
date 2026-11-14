import { act, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeApplier } from "../components/ThemeApplier";
import { useThemePreference } from "./useTheme";

type Listener = () => void;
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<Listener>();
  const mq = {
    matches: initialDark,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
  };
  (window as unknown as { matchMedia: unknown }).matchMedia = () => mq;
  return {
    setOsDark(v: boolean) {
      mq.matches = v;
      listeners.forEach((l) => l());
    },
  };
}
const attr = () => document.documentElement.getAttribute("data-theme");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme preference", () => {
  it("applies dark by default", () => {
    stubMatchMedia(false); // an OS that prefers light must not matter for the default
    render(<ThemeApplier />);
    expect(attr()).toBe("dark");
  });

  it("changing the setting elsewhere updates <html> without a restart", () => {
    stubMatchMedia(true);
    render(<ThemeApplier />);
    const setting = renderHook(() => useThemePreference());
    act(() => setting.result.current[1]("light"));
    expect(attr()).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    act(() => setting.result.current[1]("dark"));
    expect(attr()).toBe("dark");
  });

  it("'system' follows the OS live, and explicit choices ignore it", () => {
    const os = stubMatchMedia(true);
    render(<ThemeApplier />);
    const setting = renderHook(() => useThemePreference());
    act(() => setting.result.current[1]("system"));
    expect(attr()).toBe("dark");
    act(() => os.setOsDark(false));
    expect(attr()).toBe("light");
    act(() => setting.result.current[1]("dark"));
    act(() => os.setOsDark(true));
    act(() => os.setOsDark(false));
    expect(attr()).toBe("dark");
  });
});
