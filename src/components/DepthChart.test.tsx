import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DepthChart } from "./DepthChart";

describe("DepthChart", () => {
  it("renders both sides and the peak cumulative volume", () => {
    // Sell cumulative: 5, 12. Buy cumulative: 6, 10. Peak = 12.
    render(
      <DepthChart
        sell={[
          { price: 10, volume: 5 },
          { price: 12, volume: 7 },
        ]}
        buy={[
          { price: 9, volume: 6 },
          { price: 8, volume: 4 },
        ]}
      />,
    );
    expect(screen.getByText("Buy depth")).toBeInTheDocument();
    expect(screen.getByText("Sell depth")).toBeInTheDocument();
    expect(screen.getByText(/peak 12/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no orders", () => {
    render(<DepthChart sell={[]} buy={[]} />);
    expect(screen.getByText(/No orders to chart/)).toBeInTheDocument();
  });
});
