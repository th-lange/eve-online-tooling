import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DpsTick } from "../../lib/api";
import { DpsChartContainer } from "./DpsChartContainer";
import { formatClock, SERIES_OUT, SERIES_IN } from "./dpsMeterShared";

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

function tick(at: number, dpsOut = 10): DpsTick {
  return {
    at,
    windowSecs: 10,
    dpsOut,
    dpsIn: 0,
    logiOut: 0,
    logiIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    miningM3: 0,
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
  };
}

const ticks = [tick(1000), tick(1010), tick(1020), tick(1030)];

function renderCharts(markTs?: number | null) {
  return render(
    <DpsChartContainer
      bySource={false}
      onSetBySource={vi.fn()}
      chartLayout="side"
      onSetChartLayout={vi.fn()}
      filteredTicks={ticks}
      outSeries={SERIES_OUT}
      inSeries={SERIES_IN}
      combinedSeries={SERIES_OUT}
      markTs={markTs}
    />,
  );
}

describe("DpsChartContainer log-position marker", () => {
  it("shows no marker label when markTs is unset", () => {
    renderCharts(null);
    expect(screen.queryByText(/log @/)).not.toBeInTheDocument();
  });

  it("labels the marker with the nearest tick's time once markTs is set", () => {
    renderCharts(1022); // closest to the tick at 1020
    const labels = screen.getAllByText(`log @ ${formatClock(1020)}`);
    // One per chart panel (Outgoing + Incoming in "side" layout).
    expect(labels.length).toBe(2);
  });
});
