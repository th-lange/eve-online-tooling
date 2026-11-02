import { beforeEach, describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import type { MarketOrder } from "../../lib/api";
import { openItemInMarketSearch } from "../../lib/deepLink";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";

import { MarketSearchPage } from "./MarketSearchPage";

const SDE_OK = { installed: true, path: "/sde", sizeBytes: 1, updated: false };

function order(price: number, station: string): MarketOrder {
  return {
    price,
    volumeRemain: 10,
    stationId: 1,
    stationName: station,
    systemId: 30000142,
    systemName: "Jita",
    regionName: "The Forge",
    security: 0.9,
    jumps: null,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
});

describe("MarketSearchPage search tab", () => {
  it("lists buy orders under the sell orders, each table showing its own side", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      market_all_regions: () => [],
      market_current_location: () => null,
      market_sell_orders: () => [order(105, "Sell Station")],
      market_buy_orders: () => [order(95, "Buy Station")],
      market_order_book: () => ({ sell: [], buy: [] }),
    });
    openItemInMarketSearch({ id: 34, name: "Tritanium" });
    renderWithQuery(<MarketSearchPage />);

    const sellHeading = await screen.findByText(/Sell orders/);
    const buyHeading = screen.getByText(/Buy orders/);
    const sellTable = within(sellHeading.closest("section")!);
    const buyTable = within(buyHeading.closest("section")!);

    expect(await sellTable.findByText("Sell Station")).toBeInTheDocument();
    expect(sellTable.queryByText("Buy Station")).not.toBeInTheDocument();
    expect(await buyTable.findByText("Buy Station")).toBeInTheDocument();
    expect(buyTable.queryByText("Sell Station")).not.toBeInTheDocument();
  });

  it("still shows buy orders when the area has no sell orders", async () => {
    mockInvoke({
      sde_status: () => SDE_OK,
      market_all_regions: () => [],
      market_current_location: () => null,
      market_sell_orders: () => [],
      market_buy_orders: () => [order(95, "Buy Station")],
      market_order_book: () => ({ sell: [], buy: [] }),
    });
    openItemInMarketSearch({ id: 34, name: "Tritanium" });
    renderWithQuery(<MarketSearchPage />);

    expect(await screen.findByText("Buy Station")).toBeInTheDocument();
    expect(screen.getByText("No sell orders found.")).toBeInTheDocument();
  });
});
