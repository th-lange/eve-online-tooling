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

describe("PriceHistoryView", () => {
  it("Range controls the underlying window (rows + stats), defaulting to 90d", () => {
    const { container } = render(<PriceHistoryView history={history(100)} />);
    expect(rows(container)).toBe(90); // last 90 of 100
    const at90 = avgVol();

    fireEvent.change(screen.getByRole("combobox", { name: /Range/ }), {
      target: { value: "30" },
    });
    expect(rows(container)).toBe(30);
    expect(avgVol()).not.toBe(at90); // stats recompute over the new window
  });

  it("MA/channel period does not change the underlying data", () => {
    const { container } = render(<PriceHistoryView history={history(100)} />);
    const before = avgVol();
    fireEvent.change(screen.getByRole("combobox", { name: /MA\/channel/ }), {
      target: { value: "90" },
    });
    // Period only drives the MA line + Donchian band — not the raw window.
    expect(rows(container)).toBe(90);
    expect(avgVol()).toBe(before);
  });
});
