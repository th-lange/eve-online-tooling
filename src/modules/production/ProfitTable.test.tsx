import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "../../test/harness";
import { ProfitTable } from "./ProfitTable";
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
});
