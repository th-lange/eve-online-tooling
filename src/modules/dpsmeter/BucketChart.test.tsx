import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { BucketChart } from "./BucketChart";
import { BUCKET_SERIES_OUT } from "./dpsMeterShared";
import type { DpsBucket } from "../../lib/api";

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

function bucket(i: number, damageOut: number): DpsBucket {
  return {
    start: i * 5,
    end: i * 5 + 5,
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

// PAD_Y in BucketChart — the top of the plot area. A point at the series peak
// maps exactly here.
const PLOT_TOP = 10;

describe("BucketChart", () => {
  it("scales the axis to the smoothed peak so the line fills the chart", () => {
    // A bursty saw-tooth: a volley every other bucket. If the axis were scaled
    // to the RAW spike while the line is smoothed, the line would hug the
    // bottom (the bug this guards). Scaled to the smoothed peak, the busiest
    // smoothed point reaches the top of the plot.
    const buckets = Array.from({ length: 10 }, (_, i) =>
      bucket(i, i % 2 === 0 ? 1000 : 0),
    );
    const { container } = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} />,
    );
    const ys = container
      .querySelector("polyline")!
      .getAttribute("points")!
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    expect(Math.min(...ys)).toBeCloseTo(PLOT_TOP, 1);
  });
});
