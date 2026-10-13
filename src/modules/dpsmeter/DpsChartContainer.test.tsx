import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { DpsBucket } from "../../lib/api";
import { DpsChartContainer } from "./DpsChartContainer";
import {
  BUCKET_SERIES_IN,
  BUCKET_SERIES_OUT,
  formatClock,
} from "./dpsMeterShared";

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

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
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
  };
}

const buckets = [bucket(1000), bucket(1005), bucket(1010), bucket(1015)];

function renderCharts({
  markRange = null as { start: number; end: number } | null,
} = {}) {
  return render(
    <DpsChartContainer
      bySource={false}
      onSetBySource={vi.fn()}
      chartLayout="side"
      onSetChartLayout={vi.fn()}
      buckets={buckets}
      outSeries={BUCKET_SERIES_OUT}
      inSeries={BUCKET_SERIES_IN}
      combinedSeries={BUCKET_SERIES_OUT}
      markRange={markRange}
    />,
  );
}

describe("DpsChartContainer — bucket time grid (#984)", () => {
  it("draws both panels from the fixed 5s buckets", () => {
    renderCharts();
    // Both panels (Outgoing + Incoming in side layout) carry the grid tag,
    // and the out chart's peak is the bucket rate (50 hp / 5 s = 10/s).
    expect(screen.getAllByText(/5s grid/).length).toBe(2);
    expect(screen.getByText("peak 10")).toBeInTheDocument();
  });

  it("labels the log position with the enclosing bucket's start", () => {
    // A range inside the single bucket starting at 1010.
    renderCharts({ markRange: { start: 1012, end: 1013 } });
    expect(screen.getAllByText(`log @ ${formatClock(1010)}`).length).toBe(2);
  });

  it("shows no log-position label when markRange is unset", () => {
    renderCharts();
    expect(screen.queryByText(/log @/)).not.toBeInTheDocument();
  });
});
