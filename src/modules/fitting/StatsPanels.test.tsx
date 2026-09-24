import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CapGauge } from "./StatsPanels";
import type { CapStats } from "../../lib/api";

function cap(overrides: Partial<CapStats>): CapStats {
  return {
    capacity: 5000,
    rechargeSeconds: 300,
    peakRecharge: 20,
    drain: 10,
    stable: true,
    stablePct: 80,
    depletionSeconds: null,
    trajectory: [],
    ...overrides,
  };
}

describe("CapGauge", () => {
  it("labels a stable cap with text, not just color", () => {
    render(<CapGauge cap={cap({ stable: true, stablePct: 62 })} />);
    expect(screen.getByText(/Stable/)).toBeInTheDocument();
    expect(screen.getByText(/62%/)).toBeInTheDocument();
  });

  it("labels a draining cap with the time-to-empty, not just color", () => {
    render(
      <CapGauge
        cap={cap({ stable: false, stablePct: null, depletionSeconds: 125 })}
      />,
    );
    expect(screen.getByText(/Empties in/)).toBeInTheDocument();
    expect(screen.queryByText(/Stable/)).not.toBeInTheDocument();
  });
});
