import { describe, expect, it, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePersistentState } from "./usePersistentState";
import { notifyExternalStorageChange } from "./externalStorageEvent";

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistentState", () => {
  it("initializes from localStorage and persists on change", () => {
    localStorage.setItem("k", JSON.stringify("saved"));
    const { result } = renderHook(() => usePersistentState("k", "default"));
    expect(result.current[0]).toBe("saved");

    act(() => result.current[1]("updated"));
    expect(result.current[0]).toBe("updated");
    expect(localStorage.getItem("k")).toBe(JSON.stringify("updated"));
  });

  it("falls back to the initial value when nothing is stored", () => {
    const { result } = renderHook(() => usePersistentState("missing", 42));
    expect(result.current[0]).toBe(42);
  });

  it("re-reads from localStorage when an external-storage event fires for its key", () => {
    const { result } = renderHook(() => usePersistentState("ext-key", "a"));
    expect(result.current[0]).toBe("a");

    // Something writes directly to localStorage, bypassing the hook's own
    // setter (e.g. a folder-sync store's `apply()`), then notifies.
    localStorage.setItem("ext-key", JSON.stringify("b"));
    act(() => notifyExternalStorageChange("ext-key"));

    expect(result.current[0]).toBe("b");
  });

  it("ignores an external-storage event for a different key", () => {
    const { result } = renderHook(() => usePersistentState("own-key", "a"));
    localStorage.setItem("own-key", JSON.stringify("should-not-apply"));

    act(() => notifyExternalStorageChange("other-key"));

    expect(result.current[0]).toBe("a");
  });
});
