import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { AppError, DayTradeRow, Region } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { DaytradingPage } from "./DaytradingPage";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

const REGIONS: Region[] = [
  {
    id: 10000002,
    name: "The Forge",
    stations: [{ id: 60003760, name: "Jita IV - Moon 4" }],
  },
  {
    id: 10000043,
    name: "Domain",
    stations: [{ id: 60008494, name: "Amarr VIII" }],
  },
];

const ROW: DayTradeRow = {
  typeId: 34,
  name: "Tritanium",
  buyRegionId: 10000002,
  buyHub: "Jita",
  buyPrice: 4.5,
  sellRegionId: 10000043,
  sellHub: "Amarr",
  sellPrice: 5.2,
  profitPerUnit: 0.6,
  shippingPerUnit: 0.1,
  margin: 0.13,
  volumeM3: 0.01,
  iskPerM3: 60,
  destVolume: 1_000_000,
  suggestedQty: 1_000_000,
  totalProfit: 600_000,
  daysOfSupply: 3,
  favorite: false,
  category: "Material",
  group: "Mineral",
  metaGroup: null,
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("DaytradingPage", () => {
  it("scans and renders a day-trade opportunity row", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      market_regions: () => REGIONS,
      sde_market_categories: () => [],
      esi_roster_stock: () => ({}),
      daytrading_scan: () => [ROW],
    });
    renderWithQuery(<DaytradingPage />);

    const calcButton = await screen.findByRole("button", {
      name: /calculate/i,
    });
    await waitFor(() => expect(calcButton).toBeEnabled());
    fireEvent.click(calcButton);

    expect(await screen.findByText("Tritanium")).toBeInTheDocument();
  });

  it("shows the scan failure message", async () => {
    const error: AppError = {
      kind: "message",
      message: "market snapshot stale",
    };
    mockInvoke({
      sde_status: () => SDE_OK,
      market_regions: () => REGIONS,
      sde_market_categories: () => [],
      esi_roster_stock: () => ({}),
      daytrading_scan: () => {
        throw error;
      },
    });
    renderWithQuery(<DaytradingPage />);

    const calcButton = await screen.findByRole("button", {
      name: /calculate/i,
    });
    await waitFor(() => expect(calcButton).toBeEnabled());
    fireEvent.click(calcButton);

    expect(
      await screen.findByText(/market snapshot stale/),
    ).toBeInTheDocument();
  });
});
