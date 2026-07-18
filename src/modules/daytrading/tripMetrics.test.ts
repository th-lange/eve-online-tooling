import { describe, expect, it } from "vitest";
import type { DayTradeRow } from "../../lib/api";
import { tripMetrics } from "./tripMetrics";

function row(overrides: Partial<DayTradeRow> = {}): DayTradeRow {
  return {
    typeId: 34,
    name: "Tritanium",
    buyRegionId: 10000002,
    buyHub: "Jita",
    buyPrice: 5,
    sellRegionId: 10000043,
    sellHub: "Amarr",
    sellPrice: 6,
    profitPerUnit: 1,
    shippingPerUnit: 0.01,
    margin: 0.2,
    volumeM3: 0.01,
    iskPerM3: 100,
    destVolume: 1_000_000,
    suggestedQty: 1_000_000,
    totalProfit: 1_000_000,
    daysOfSupply: 1,
    favorite: false,
    category: null,
    group: null,
    metaGroup: null,
    ...overrides,
  };
}

describe("tripMetrics", () => {
  it("computes units/profit/trips for a basic case", () => {
    const r = row({ volumeM3: 10, profitPerUnit: 5, suggestedQty: 100 });
    expect(tripMetrics(r, 50)).toEqual({
      unitsPerTrip: 5, // floor(50 / 10)
      profitPerTrip: 25, // min(100, 5) * 5
      trips: 20, // ceil(100 * 10 / 50)
    });
  });

  it("returns null when cargoM3 is 0 or negative (feature off)", () => {
    const r = row({ volumeM3: 10, profitPerUnit: 5, suggestedQty: 100 });
    expect(tripMetrics(r, 0)).toBeNull();
    expect(tripMetrics(r, -1)).toBeNull();
  });

  it("rounds trips up on a non-exact division", () => {
    // suggestedQty * volumeM3 = 100 * 3 = 300; 300 / 200 = 1.5 -> ceil to 2.
    const r = row({ volumeM3: 3, profitPerUnit: 2, suggestedQty: 100 });
    const m = tripMetrics(r, 200);
    expect(m).not.toBeNull();
    expect(m?.trips).toBe(2);
    expect(m?.unitsPerTrip).toBe(66); // floor(200 / 3)
    expect(m?.profitPerTrip).toBe(132); // min(100, 66) * 2
  });
});
