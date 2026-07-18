import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sortBreakdowns,
  sortRows,
  formatAgo,
  formatEveDateTime,
  formatIsk,
  formatPercent,
} from "./format";
import type { ProfitBreakdown } from "./api";

function row(
  productName: string,
  profit: number,
  productVolume: number | null,
): ProfitBreakdown {
  return {
    blueprintTypeId: 0,
    productTypeId: 0,
    productName,
    runs: 1,
    me: 0,
    jobTimeSeconds: 0,
    unitsProduced: 1,
    materialCost: 0,
    jobFee: 0,
    blueprintCost: 0,
    inventionCost: 0,
    invention: null,
    revenue: 0,
    profit,
    margin: null,
    roi: null,
    profitPerUnit: profit,
    metaGroup: null,
    category: null,
    group: null,
    market: null,
    sellHub: null,
    favorite: false,
    productVolume,
    productPrice: null,
    materials: [],
    missingPrices: [],
  };
}

describe("format", () => {
  it("formats values and handles null", () => {
    expect(formatIsk(1234.5)).toBe("1,234.5");
    expect(formatIsk(null)).toBe("—");
    expect(formatPercent(0.7168)).toBe("71.7%");
    expect(formatPercent(null)).toBe("—");
  });

  it("sorts by profit descending and keeps null volumes last", () => {
    const rows = [row("A", 10, 5), row("B", 30, null), row("C", 20, 7)];
    const byProfit = sortBreakdowns(rows, "profit", "desc");
    expect(byProfit.map((r) => r.productName)).toEqual(["B", "C", "A"]);

    const byVolume = sortBreakdowns(rows, "productVolume", "desc");
    // B has null volume -> sorts last despite desc
    expect(byVolume.map((r) => r.productName)).toEqual(["C", "A", "B"]);
  });

  describe("formatEveDateTime", () => {
    it("trims an ESI ISO timestamp to YYYY-MM-DD HH:MM in UTC", () => {
      expect(formatEveDateTime("2026-07-18T09:30:45Z")).toBe(
        "2026-07-18 09:30",
      );
      // Offset timestamps are normalized to UTC, not shown verbatim.
      expect(formatEveDateTime("2026-07-18T09:30:45+02:00")).toBe(
        "2026-07-18 07:30",
      );
    });

    it("stays UTC regardless of the local timezone", () => {
      // The rendered hour must match the Z-timestamp's UTC hour even though
      // the test process runs in some arbitrary local zone.
      const iso = "2026-01-02T23:59:00Z";
      expect(formatEveDateTime(iso)).toBe("2026-01-02 23:59");
    });

    it("handles empty and unparseable input", () => {
      expect(formatEveDateTime("")).toBe("—");
      expect(formatEveDateTime(null)).toBe("—");
      expect(formatEveDateTime(undefined)).toBe("—");
      expect(formatEveDateTime("not-a-date")).toBe("not-a-date");
    });
  });

  describe("formatAgo", () => {
    const NOW = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18T12:00:00Z

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders each unit at its threshold", () => {
      expect(formatAgo(NOW)).toBe("just now");
      expect(formatAgo(NOW - 59_000)).toBe("just now");
      expect(formatAgo(NOW - 60_000)).toBe("1m ago");
      expect(formatAgo(NOW - 3_599_000)).toBe("59m ago");
      expect(formatAgo(NOW - 3_600_000)).toBe("1h ago");
      expect(formatAgo(NOW - 86_399_000)).toBe("23h ago");
      expect(formatAgo(NOW - 86_400_000)).toBe("1d ago");
      expect(formatAgo(NOW - 2_591_999_000)).toBe("29d ago");
    });

    it("falls back to a UTC date beyond 30 days", () => {
      expect(formatAgo(NOW - 2_592_000_000)).toBe("2026-06-18");
      expect(formatAgo(Date.UTC(2026, 0, 1))).toBe("2026-01-01");
    });

    it("clamps future timestamps to just now", () => {
      expect(formatAgo(NOW + 120_000)).toBe("just now");
    });
  });

  it("sortRows with nullsLast sorts null values last in both directions", () => {
    type Item = { name: string; value: number | null };
    const items: Item[] = [
      { name: "A", value: 5 },
      { name: "B", value: null },
      { name: "C", value: 2 },
    ];

    const asc = sortRows(items, "value", "asc", { nullsLast: true });
    expect(asc.map((r) => r.name)).toEqual(["C", "A", "B"]);

    const desc = sortRows(items, "value", "desc", { nullsLast: true });
    expect(desc.map((r) => r.name)).toEqual(["A", "C", "B"]);
  });
});
