import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Region, TradeRow } from "../../lib/api";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { TradingPage } from "./TradingPage";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

const REGIONS: Region[] = [
  {
    id: 10000002,
    name: "The Forge",
    stations: [{ id: 60003760, name: "Jita IV - Moon 4" }],
  },
];

const ROW: TradeRow = {
  typeId: 34,
  name: "Tritanium",
  buy: 4.4,
  sell: 4.6,
  profitPerUnit: 0.15,
  margin: 0.03,
  volume: 500_000,
  buyVolume: 400_000,
  buySellRatio: 0.8,
  dailyTraded: 2_000_000,
  daysOfSupply: 0.25,
  priceFlag: null,
  favorite: false,
  category: "Material",
  group: "Mineral",
  metaGroup: null,
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("TradingPage", () => {
  it("scans and renders a station-trading opportunity row", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      market_regions: () => REGIONS,
      station_trading: () => [ROW],
    });
    renderWithQuery(<TradingPage />);

    fireEvent.click(await screen.findByRole("button", { name: /calculate/i }));

    expect(await screen.findByText("Tritanium")).toBeInTheDocument();
  });

  it("shows the scan failure message", async () => {
    // `station_trading` (src-tauri/src/modules/trading/commands.rs) still
    // rejects with a plain `String`, not the structured AppError — the
    // page's `ErrorMsg` renders `String(e)` accordingly (no `errorMessage()`
    // call), so the fixture and assertion mirror that, not the AppError shape.
    mockInvoke({
      sde_status: () => SDE_OK,
      market_regions: () => REGIONS,
      station_trading: () => Promise.reject("market snapshot stale"),
    });
    renderWithQuery(<TradingPage />);

    fireEvent.click(await screen.findByRole("button", { name: /calculate/i }));

    expect(
      await screen.findByText(/market snapshot stale/),
    ).toBeInTheDocument();
  });
});
