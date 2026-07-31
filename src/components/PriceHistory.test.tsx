import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { HistoryPoint } from "../lib/api";
import { PriceHistoryView } from "./PriceHistory";

const point = (over: Partial<HistoryPoint> = {}): HistoryPoint => ({
  date: "2026-07-01",
  average: 100,
  highest: 110,
  lowest: 90,
  volume: 50,
  orderCount: 5,
  ...over,
});

describe("PriceHistoryView", () => {
  it("renders an empty state instead of throwing on an empty series", () => {
    render(<PriceHistoryView history={[]} />);
    expect(screen.getByText(/no price history/i)).toBeInTheDocument();
  });

  it("renders the latest figures when history is present", () => {
    render(<PriceHistoryView history={[point(), point({ average: 200 })]} />);
    expect(screen.getByText("Latest avg")).toBeInTheDocument();
  });
});
