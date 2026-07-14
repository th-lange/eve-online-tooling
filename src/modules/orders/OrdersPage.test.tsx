import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrderRow, ProfitBreakdown } from "../../lib/api";

const sell = (
  orderId: number,
  typeId: number,
  name: string,
  price: number,
): OrderRow => ({
  characterId: 1,
  characterName: "Me",
  orderId,
  typeId,
  name,
  isBuy: false,
  price,
  volumeRemain: 5,
  volumeTotal: 10,
  location: "Jita IV - Moon 4",
  regionId: 10000002,
  locationId: 60003760, // Jita IV-4
  bestPrice: price, // undercutPrice = price - 0.01
  undercut: true,
  issued: "2026-07-01T00:00:00Z",
});

// Widget's undercut price (899.99) is below its 1000 build cost; Gadget's
// (4999.99) is well above.
const ORDERS: OrderRow[] = [
  sell(1, 100, "Widget", 900),
  sell(2, 200, "Gadget", 5000),
];

const cost = (
  productTypeId: number,
  materialCost: number,
): ProfitBreakdown => ({
  blueprintTypeId: 0,
  productTypeId,
  productName: "",
  runs: 1,
  me: 0,
  jobTimeSeconds: 0,
  unitsProduced: 1,
  materialCost,
  jobFee: 0,
  blueprintCost: 0,
  inventionCost: 0,
  invention: null,
  revenue: 0,
  profit: 0,
  margin: null,
  roi: null,
  profitPerUnit: 0,
  metaGroup: null,
  category: null,
  group: null,
  market: null,
  sellHub: null,
  favorite: false,
  productVolume: null,
  productPrice: null,
  materials: [],
  missingPrices: [],
});

const COSTS: ProfitBreakdown[] = [cost(100, 1000), cost(200, 1000)];

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { OrdersPage } from "./OrdersPage";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <OrdersPage />
    </QueryClientProvider>,
  );
}

describe("OrdersPage build-cost check", () => {
  it("flags sell orders whose undercut price falls below build cost", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "market_orders") return Promise.resolve(ORDERS);
      if (cmd === "production_profit") return Promise.resolve(COSTS);
      return Promise.resolve(undefined);
    });
    renderPage();
    await screen.findByText("Widget");

    // Build cost isn't pulled until the button is pressed.
    expect(invokeMock).not.toHaveBeenCalledWith("production_profit", {
      params: { regionId: 10000002 },
    });
    expect(screen.queryByText(/below build cost/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /check build cost/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("production_profit", {
        params: { regionId: 10000002 },
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith("production_profit", {
      params: { regionId: 10000002, stationId: 60003760 },
    });

    // Only Widget (899.99 < 1000) is flagged; Gadget (4999.99) is fine.
    expect(await screen.findByText(/1 below build cost/)).toBeInTheDocument();
    expect(screen.getByText("below cost")).toBeInTheDocument();
  });
});
