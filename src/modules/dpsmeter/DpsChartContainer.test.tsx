import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DpsBucket, DpsTick } from "../../lib/api";
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

function bucket(start: number, damageOut = 50): DpsBucket {
  return {
    start,
    end: start + 5,
    damageOut,
    damageIn: 0,
    repOut: 0,
    repIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    miningM3: 0,
  };
}

const ticks = [tick(1000), tick(1010), tick(1020), tick(1030)];
const buckets = [bucket(1000), bucket(1005), bucket(1010), bucket(1015)];

function renderCharts({
  markTs = null as number | null,
  pilotScoped = false,
} = {}) {
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
      buckets={buckets}
      pilotScoped={pilotScoped}
      markTs={markTs}
    />,
  );
}

describe("DpsChartContainer — bucket time grid (#983)", () => {
  it("draws Totals mode from the fixed 5s buckets", () => {
    renderCharts();
    // Both panels (Outgoing + Incoming in side layout) carry the grid tag.
    expect(screen.getAllByText(/5s grid/).length).toBe(2);
  });

  it("labels the log position with the enclosing bucket's start", () => {
    renderCharts({ markTs: 1012 }); // inside the bucket starting at 1010
    expect(screen.getAllByText(`log @ ${formatClock(1010)}`).length).toBe(2);
  });

  it("shows no log-position label when markTs is unset", () => {
    renderCharts();
    expect(screen.queryByText(/log @/)).not.toBeInTheDocument();
  });

  it("falls back to the rolling-tick chart while a pilot filter is active", () => {
    renderCharts({ pilotScoped: true, markTs: 1022 });
    // The legacy chart labels with the *nearest tick* (1020), and has no
    // bucket-grid tag.
    expect(screen.queryByText(/5s grid/)).not.toBeInTheDocument();
    expect(screen.getAllByText(`log @ ${formatClock(1020)}`).length).toBe(2);
  });
});
