import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard, useCopyToClipboard } from "./useCopyToClipboard";

const writeText = vi.fn<(t: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("copyToClipboard", () => {
  it("writes the text to the clipboard", () => {
    copyToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("never throws when the write rejects (permission denied)", () => {
    writeText.mockRejectedValue(new Error("denied"));
    expect(() => copyToClipboard("x")).not.toThrow();
  });

  it("is a no-op when the Clipboard API is unavailable", () => {
    vi.stubGlobal("navigator", {});
    expect(() => copyToClipboard("x")).not.toThrow();
  });
});

describe("useCopyToClipboard", () => {
  it("sets `copied` to the tag on copy, then clears after the reset delay", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard(1000));

    expect(result.current.copied).toBe(null);
    act(() => result.current.copy("md-text", "md"));
    expect(writeText).toHaveBeenCalledWith("md-text");
    expect(result.current.copied).toBe("md");

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.copied).toBe(null);
  });

  it("defaults `copied` to true when no tag is given", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard());
    act(() => result.current.copy("plain"));
    expect(result.current.copied).toBe(true);
  });
});
