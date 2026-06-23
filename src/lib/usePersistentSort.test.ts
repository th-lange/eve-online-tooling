import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePersistentSort } from "./usePersistentSort";

const KEYS = ["name", "profit", "volume"] as const;
type K = (typeof KEYS)[number];

function render(storageKey = "sort.test") {
  return renderHook(() =>
    usePersistentSort<K>(storageKey, KEYS, "profit", "desc", ["name"]),
  );
}

describe("usePersistentSort", () => {
  beforeEach(() => localStorage.clear());

  it("starts at the provided default", () => {
    const { result } = render();
    expect(result.current.sortKey).toBe("profit");
    expect(result.current.sortDir).toBe("desc");
  });

  it("flips direction when toggling the active column", () => {
    const { result } = render();
    act(() => result.current.toggleSort("profit"));
    expect(result.current.sortDir).toBe("asc");
  });

  it("switches column with a type-appropriate default direction", () => {
    const { result } = render();
    act(() => result.current.toggleSort("name")); // text column → asc
    expect(result.current.sortKey).toBe("name");
    expect(result.current.sortDir).toBe("asc");
    act(() => result.current.toggleSort("volume")); // numeric → desc
    expect(result.current.sortDir).toBe("desc");
  });

  it("persists and rehydrates across remounts", () => {
    const first = render("sort.persist");
    act(() => first.result.current.toggleSort("volume"));
    first.unmount();
    // A fresh mount with the same storage key restores the saved sort.
    const second = render("sort.persist");
    expect(second.result.current.sortKey).toBe("volume");
    expect(second.result.current.sortDir).toBe("desc");
  });

  it("falls back to the default when the saved column is invalid", () => {
    localStorage.setItem(
      "sort.stale",
      JSON.stringify({ key: "removed", dir: "asc" }),
    );
    const { result } = render("sort.stale");
    expect(result.current.sortKey).toBe("profit");
    expect(result.current.sortDir).toBe("desc");
  });
});
