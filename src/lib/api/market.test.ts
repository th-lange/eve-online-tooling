import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri core invoke so the wrapper can be exercised without a
// running desktop shell — same pattern as src/lib/api.test.ts.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  marketAllRegions,
  marketCurrentLocation,
  marketHistory,
  marketOrderBook,
  marketPrice,
  marketRegions,
  marketSearchStations,
  marketSellOrders,
  type SellOrdersParams,
} from "./market";

describe("market api wrapper", () => {
  beforeEach(() => invokeMock.mockReset());

  it("forwards regionId + typeId to market_history", async () => {
    invokeMock.mockResolvedValue([]);
    await marketHistory(10000002, 34);
    expect(invokeMock).toHaveBeenCalledWith("market_history", {
      regionId: 10000002,
      typeId: 34,
    });
  });

  it("defaults stationId to null for market_price", async () => {
    invokeMock.mockResolvedValue({ typeId: 34 });
    await marketPrice(10000002, 34);
    expect(invokeMock).toHaveBeenCalledWith("market_price", {
      regionId: 10000002,
      stationId: null,
      typeId: 34,
    });
  });

  it("forwards an explicit stationId to market_price", async () => {
    invokeMock.mockResolvedValue({ typeId: 34 });
    await marketPrice(10000002, 34, 60003760);
    expect(invokeMock).toHaveBeenCalledWith("market_price", {
      regionId: 10000002,
      stationId: 60003760,
      typeId: 34,
    });
  });

  it("invokes market_regions with no args", async () => {
    invokeMock.mockResolvedValue([]);
    await marketRegions();
    expect(invokeMock).toHaveBeenCalledWith("market_regions");
  });

  it("invokes market_all_regions with no args", async () => {
    invokeMock.mockResolvedValue([]);
    await marketAllRegions();
    expect(invokeMock).toHaveBeenCalledWith("market_all_regions");
  });

  it("forwards query to market_search_stations", async () => {
    invokeMock.mockResolvedValue([]);
    await marketSearchStations("Jita");
    expect(invokeMock).toHaveBeenCalledWith("market_search_stations", {
      query: "Jita",
    });
  });

  it("invokes market_current_location with no args", async () => {
    invokeMock.mockResolvedValue(null);
    await marketCurrentLocation();
    expect(invokeMock).toHaveBeenCalledWith("market_current_location");
  });

  it("forwards the whole params object to market_sell_orders under a params key", async () => {
    invokeMock.mockResolvedValue([]);
    const params: SellOrdersParams = { typeId: 34, regionId: 10000002 };
    await marketSellOrders(params);
    expect(invokeMock).toHaveBeenCalledWith("market_sell_orders", { params });
  });

  it("forwards the whole params object to market_order_book under a params key", async () => {
    invokeMock.mockResolvedValue({ sell: [], buy: [] });
    const params: SellOrdersParams = { typeId: 34, highSecOnly: true };
    await marketOrderBook(params);
    expect(invokeMock).toHaveBeenCalledWith("market_order_book", { params });
  });
});

// A separate describe block (no `beforeEach` hook) — vitest's unhandled-
// rejection detector spuriously flags a rejected mock awaited inside a
// describe block whose `beforeEach` touches the same mock, even after this
// test's own explicit reset.
describe("market api wrapper — rejection", () => {
  it("surfaces a rejected invoke through the wrapper unchanged", async () => {
    invokeMock.mockReset();
    const err = { kind: "message", message: "ESI unreachable" };
    invokeMock.mockRejectedValue(err);
    let caught: unknown;
    try {
      await marketRegions();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });
});
