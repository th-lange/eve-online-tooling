import { describe, expect, it } from "vitest";
import { SDE_SEARCH_STALE_TIME, marketKeys, sdeKeys } from "./queryKeys";

describe("marketKeys.history", () => {
  it("produces the same queryKey shape regardless of caller, so the popover and the history tab share one cache entry", () => {
    const fromPopover = marketKeys.history(10000002, 34);
    const fromHistoryTab = marketKeys.history(10000002, 34);
    expect(fromHistoryTab.queryKey).toEqual(fromPopover.queryKey);
    expect(fromPopover.queryKey).toEqual(["market", "history", 10000002, 34]);
  });

  it("keys differ across region/type so distinct items don't collide", () => {
    const a = marketKeys.history(10000002, 34);
    const b = marketKeys.history(10000043, 34);
    expect(a.queryKey).not.toEqual(b.queryKey);
  });

  it("caches history for 30 minutes, matching PriceHistoryPopover's original policy", () => {
    expect(marketKeys.history(10000002, 34).staleTime).toBe(30 * 60 * 1000);
  });
});

describe("sdeKeys.search", () => {
  it("keys by the query string under a dedicated sde/search namespace", () => {
    expect(sdeKeys.search("tritanium").queryKey).toEqual([
      "sde",
      "search",
      "tritanium",
    ]);
  });

  it("caches search results for 24 hours, since the SDE is static between refreshes", () => {
    expect(sdeKeys.search("tritanium").staleTime).toBe(SDE_SEARCH_STALE_TIME);
    expect(SDE_SEARCH_STALE_TIME).toBe(24 * 60 * 60 * 1000);
  });
});
