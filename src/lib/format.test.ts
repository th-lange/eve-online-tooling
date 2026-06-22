import { describe, expect, it } from "vitest";
import { formatIsk, formatPercent, sortBreakdowns } from "./format";
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
    unitsProduced: 1,
    materialCost: 0,
    jobFee: 0,
    revenue: 0,
    profit,
    margin: null,
    roi: null,
    profitPerUnit: profit,
    metaGroup: null,
    productVolume,
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
});
