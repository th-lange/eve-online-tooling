import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "../../test/harness";
import { ProfitTable } from "./ProfitTable";
import { sortBreakdowns } from "../../lib/format";
import type { ProfitBreakdown } from "../../lib/api";
const T2_ROW: ProfitBreakdown = {
  blueprintTypeId: 2, // Gyrostabilizer II
  productTypeId: 2,
  productName: "Gyrostabilizer II",
  runs: 1,
  me: 10,
  jobTimeSeconds: 600,
  unitsProduced: 1,
  materialCost: 1_000,
  jobFee: 100,
  blueprintCost: 0,
  inventionCost: 500,
  invention: {
    datacores: [],
    datacoreCost: 0,
    inventionJobFee: 0,
    copyFee: 0,
    attemptCost: 500,
    probability: 0.34,
    runsPerSuccess: 10,
    perUnit: 50,
    baseBlueprintTypeId: 1,
    baseBlueprintName: "Gyrostabilizer Blueprint",
  },
  revenue: 3_000,
  profit: 1_400,
  margin: 0.47,
  roi: 0.88,
  profitPerUnit: 1_400,
  metaGroup: "Tech II",
  category: "Module",
  group: "Ballistic Control System",
  market: "Jita",
  sellHub: null,
  favorite: false,
  productVolume: 100,
  productPrice: 3_000,
  materials: [],
  missingPrices: [],
};

describe("ProfitTable", () => {
  it("shows the base blueprint a T2 item is invented from when expanded", () => {
    renderWithQuery(
      <ProfitTable
        rows={[T2_ROW]}
        regionId={10000002}
        onFavorite={vi.fn()}
        onBlacklist={vi.fn()}
      />,
    );

    expect(
      screen.queryByText(/Invention from Gyrostabilizer Blueprint/),
    ).toBeNull();

    fireEvent.click(screen.getByText("Gyrostabilizer II"));

    expect(
      screen.getByText(/Invention from Gyrostabilizer Blueprint/),
    ).toBeInTheDocument();
  });

  it("shows the missing-prices warning icon when a row has unpriced materials", () => {
    renderWithQuery(
      <ProfitTable
        rows={[{ ...T2_ROW, missingPrices: [99] }]}
        regionId={10000002}
        onFavorite={vi.fn()}
        onBlacklist={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText(
        "Missing prices for 1 item(s) — numbers are incomplete",
      ),
    ).toBeInTheDocument();
  });

  it("hides the missing-prices warning when every material priced", () => {
    renderWithQuery(
      <ProfitTable
        rows={[T2_ROW]}
        regionId={10000002}
        onFavorite={vi.fn()}
        onBlacklist={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText(/Missing prices for/)).toBeNull();
  });

  it("carries an explicit sign on ROI and profit-per-unit for negative rows", () => {
    renderWithQuery(
      <ProfitTable
        rows={[{ ...T2_ROW, roi: -0.42, profitPerUnit: -900 }]}
        regionId={10000002}
        onFavorite={vi.fn()}
        onBlacklist={vi.fn()}
      />,
    );

    expect(screen.getByText("\u221242.0%")).toBeInTheDocument();
    expect(screen.getByText("\u2212900")).toBeInTheDocument();
  });
});

describe("sortBreakdowns", () => {
  function row(overrides: Partial<ProfitBreakdown>): ProfitBreakdown {
    return { ...T2_ROW, ...overrides };
  }

  it("sorts by productName lexically", () => {
    const rows = [
      row({ blueprintTypeId: 1, productName: "Charon" }),
      row({ blueprintTypeId: 2, productName: "Anathema" }),
      row({ blueprintTypeId: 3, productName: "Bhaalgorn" }),
    ];
    const sorted = sortBreakdowns(rows, "productName", "asc");
    expect(sorted.map((r) => r.productName)).toEqual([
      "Anathema",
      "Bhaalgorn",
      "Charon",
    ]);
  });

  it("sorts by profit descending, nulls unaffected since profit is never null", () => {
    const rows = [
      row({ blueprintTypeId: 1, profit: 100 }),
      row({ blueprintTypeId: 2, profit: 300 }),
      row({ blueprintTypeId: 3, profit: 200 }),
    ];
    expect(
      sortBreakdowns(rows, "profit", "desc").map((r) => r.blueprintTypeId),
    ).toEqual([2, 3, 1]);
    expect(
      sortBreakdowns(rows, "profit", "asc").map((r) => r.blueprintTypeId),
    ).toEqual([1, 3, 2]);
  });

  it("sorts by roi and always pushes null roi to the end regardless of direction", () => {
    const rows = [
      row({ blueprintTypeId: 1, roi: 0.5 }),
      row({ blueprintTypeId: 2, roi: null }),
      row({ blueprintTypeId: 3, roi: 0.1 }),
    ];
    expect(
      sortBreakdowns(rows, "roi", "desc").map((r) => r.blueprintTypeId),
    ).toEqual([1, 3, 2]);
    expect(
      sortBreakdowns(rows, "roi", "asc").map((r) => r.blueprintTypeId),
    ).toEqual([3, 1, 2]);
  });

  it("sorts by margin", () => {
    const rows = [
      row({ blueprintTypeId: 1, margin: 0.2 }),
      row({ blueprintTypeId: 2, margin: 0.6 }),
    ];
    expect(
      sortBreakdowns(rows, "margin", "desc").map((r) => r.blueprintTypeId),
    ).toEqual([2, 1]);
  });

  it("sorts by profitPerUnit", () => {
    const rows = [
      row({ blueprintTypeId: 1, profitPerUnit: 10 }),
      row({ blueprintTypeId: 2, profitPerUnit: 1_000 }),
    ];
    expect(
      sortBreakdowns(rows, "profitPerUnit", "desc").map(
        (r) => r.blueprintTypeId,
      ),
    ).toEqual([2, 1]);
  });

  it("sorts by productPrice", () => {
    const rows = [
      row({ blueprintTypeId: 1, productPrice: 500 }),
      row({ blueprintTypeId: 2, productPrice: 50 }),
    ];
    expect(
      sortBreakdowns(rows, "productPrice", "asc").map((r) => r.blueprintTypeId),
    ).toEqual([2, 1]);
  });

  it("sorts by unitCost, a derived value (materials + fees + blueprint + invention / units)", () => {
    const cheap = row({
      blueprintTypeId: 1,
      materialCost: 100,
      jobFee: 0,
      blueprintCost: 0,
      inventionCost: 0,
      unitsProduced: 1,
    });
    const expensive = row({
      blueprintTypeId: 2,
      materialCost: 1_000,
      jobFee: 0,
      blueprintCost: 0,
      inventionCost: 0,
      unitsProduced: 1,
    });
    const zeroUnits = row({ blueprintTypeId: 3, unitsProduced: 0 });
    expect(
      sortBreakdowns([expensive, cheap, zeroUnits], "unitCost", "asc").map(
        (r) => r.blueprintTypeId,
      ),
    ).toEqual([1, 2, 3]); // zeroUnits -> null unitCost sorts last even ascending
  });

  it("sorts by productVolume, nulls last", () => {
    const rows = [
      row({ blueprintTypeId: 1, productVolume: 10 }),
      row({ blueprintTypeId: 2, productVolume: null }),
      row({ blueprintTypeId: 3, productVolume: 50 }),
    ];
    expect(
      sortBreakdowns(rows, "productVolume", "desc").map(
        (r) => r.blueprintTypeId,
      ),
    ).toEqual([3, 1, 2]);
  });
});
