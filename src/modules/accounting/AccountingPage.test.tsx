import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { invokeMock, mockInvoke, renderWithQuery } from "../../test/harness";
import { AccountingPage } from "./AccountingPage";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("AccountingPage — Profit tab", () => {
  it("renders a net loss with an explicit minus sign and non-emerald color", async () => {
    mockInvoke({
      accounting_profit_fifo: () => ({
        rows: [
          {
            name: "Tritanium",
            unitsSold: 100,
            revenue: 50,
            cost: 200,
            profit: -150,
            unmatchedUnits: 0,
            lastSold: "2026-01-01T00:00:00Z",
          },
        ],
        totalProfit: -150,
      }),
    });
    renderWithQuery(<AccountingPage />);

    fireEvent.click(screen.getByText("Profit (FIFO)"));
    fireEvent.click(screen.getByText("Sync"));

    const matches = await screen.findAllByText(/^\u2212150$/);
    expect(matches).toHaveLength(2);
    for (const el of matches) {
      expect(el.className).toContain("text-rose-400");
      expect(el.className).not.toContain("text-emerald-400");
    }
  });
});
