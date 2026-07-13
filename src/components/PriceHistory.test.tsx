import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PriceHistoryView } from "./PriceHistory";
import type { HistoryPoint } from "../lib/api";

/** `n` days of history with a distinct, increasing volume per day. */
function history(n: number): HistoryPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `d${String(i).padStart(3, "0")}`,
    average: 100 + i,
    highest: 110 + i,
    lowest: 90 + i,
    volume: i,
    orderCount: 1,
  }));
}

const rows = (c: HTMLElement) => c.querySelectorAll("tbody tr").length;
const avgVol = () =>
  screen.getByText("Avg volume/day").nextElementSibling?.textContent;
const range = () => screen.getByRole("combobox", { name: /Range/ });

describe("PriceHistoryView", () => {
  it("Range controls the underlying window (rows + stats), incl. a 7-day option", () => {
    const { container } = render(<PriceHistoryView history={history(100)} />);
    expect(rows(container)).toBe(90); // default: last 90 of 100
    const at90 = avgVol();

    fireEvent.change(range(), { target: { value: "7" } });
    expect(rows(container)).toBe(7);
    expect(avgVol()).not.toBe(at90); // stats recompute over the new window
  });

  it("derives the MA/Donchian period from the range", () => {
    render(<PriceHistoryView history={history(100)} />);
    expect(screen.getByText("MA 20d")).toBeInTheDocument(); // 90d range -> 20
    expect(screen.getByText("Donchian 20d")).toBeInTheDocument();

    fireEvent.change(range(), { target: { value: "7" } });
    expect(screen.getByText("MA 3d")).toBeInTheDocument(); // 7d range -> 3
    expect(screen.getByText("Donchian 3d")).toBeInTheDocument();
  });
});
