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

  it("falls back to 30 minutes when the backend hasn't cached a real expiresAt yet", () => {
    const opts = marketKeys.history(10000002, 34);
    const staleTime = opts.staleTime as (query: unknown) => number;
    expect(staleTime({ state: { data: undefined } })).toBe(30 * 60 * 1000);
    expect(staleTime({ state: { data: { data: [], expiresAt: null } } })).toBe(
      30 * 60 * 1000,
    );
  });

  it("derives staleTime from the server's real expiresAt when present", () => {
    const opts = marketKeys.history(10000002, 34);
    const staleTime = opts.staleTime as (query: unknown) => number;
    const expiresAt = Date.now() + 5_000;
    const remaining = staleTime({
      state: { data: { data: [], expiresAt } },
    });
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5_000);
  });

  it("projects the Fresh envelope down to the plain history points", () => {
    const opts = marketKeys.history(10000002, 34);
    const point = {
      date: "2024-01-01",
      average: 1,
      highest: 1,
      lowest: 1,
      volume: 1,
      orderCount: 1,
    };
    expect(
      (opts.select as (fresh: unknown) => unknown)({
        data: [point],
        fetchedAt: Date.now(),
        expiresAt: null,
      }),
    ).toEqual([point]);
  });
});

describe("marketKeys.regions", () => {
  it("uses the canonical [market, regions] key every page previously inlined by hand", () => {
    expect(marketKeys.regions().queryKey).toEqual(["market", "regions"]);
  });

  it("treats the static hub list as fresh for 24 hours instead of refetching per mount/refocus", () => {
    expect(marketKeys.regions().staleTime).toBe(24 * 60 * 60 * 1000);
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
