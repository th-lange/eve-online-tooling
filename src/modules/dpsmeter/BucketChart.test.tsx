import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BucketChart } from "./BucketChart";
import { BUCKET_SERIES_OUT } from "./dpsMeterShared";
import type { DpsBucket, DpsEvent } from "../../lib/api";

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
    events: [],
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

  it("keeps a fixed time scale, right-anchored (newest flows in from the right)", () => {
    const buckets = Array.from({ length: 20 }, (_, i) => bucket(i, 100));
    const { container } = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} />,
    );
    const svg = container.querySelector("svg")!;
    // A pixel is always the same amount of time — 20 buckets × 10px, never
    // rescaled to the viewport (fit-to-width compressed mid-session).
    expect(svg.getAttribute("width")).toBe("200");
    // Right-anchored while narrower than the panel: history flows left.
    expect(svg.getAttribute("class")).toContain("ml-auto");
  });

  it("shades the cursor's whole minute, clamped to the drawn data", () => {
    // 5 buckets: 0..25s drawn. The cursor is a minute start; the band covers
    // that minute but never extends past the data (no empty-space highlight).
    const buckets = Array.from({ length: 5 }, (_, i) => bucket(i, 100));
    const mid = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} markTs={0} />,
    );
    const midRect = mid.container.querySelector('rect[fill="#818cf8"]')!;
    expect(Number(midRect.getAttribute("x"))).toBe(0);
    // Minute [0,60) clamps to the drawn [0,25) → 5 buckets × 10px.
    expect(Number(midRect.getAttribute("width"))).toBe(50);

    // A minute entirely outside the drawn range shows no band.
    const off = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} markTs={60} />,
    );
    expect(
      off.container.querySelector('rect[fill="#818cf8"]'),
    ).not.toBeInTheDocument();
  });

  it("reports the clicked cell's bucket start (incl. the ghost cell)", () => {
    const buckets = Array.from({ length: 5 }, (_, i) => bucket(i, 100));
    const onSelectBucket = vi.fn();
    const { container } = render(
      <BucketChart
        buckets={buckets}
        series={BUCKET_SERIES_OUT}
        onSelectBucket={onSelectBucket}
        ghost={{ start: 25, damageOut: 50, damageIn: 0 }}
      />,
    );
    const svg = container.querySelector("svg")!;
    // jsdom rects are at 0, so clientX maps straight to chart px
    // (10px/bucket floor): 25px → cell 2 → bucket start 10.
    fireEvent.click(svg, { clientX: 25 });
    expect(onSelectBucket).toHaveBeenLastCalledWith(10);
    // 55px → cell 5, one past the 5 real buckets → the ghost (start 25).
    fireEvent.click(svg, { clientX: 55 });
    expect(onSelectBucket).toHaveBeenLastCalledWith(25);
  });

  it("extends the minute band over the ghost cell at the live edge", () => {
    const buckets = Array.from({ length: 5 }, (_, i) => bucket(i, 100));
    const { container } = render(
      <BucketChart
        buckets={buckets}
        series={BUCKET_SERIES_OUT}
        ghost={{ start: 25, damageOut: 50, damageIn: 0 }}
        markTs={0}
      />,
    );
    // Dashed ghost outline at the cell past the last real bucket.
    const dashed = container.querySelector('rect[stroke-dasharray="3 3"]')!;
    expect(Number(dashed.getAttribute("x"))).toBe((25 / 5) * 10 + 1);
    // Minute 0 clamps to the drawn range INCLUDING the ghost: [0, 30) → 60px.
    const mark = container.querySelector('rect[fill="#818cf8"]')!;
    expect(Number(mark.getAttribute("x"))).toBe(0);
    expect(Number(mark.getAttribute("width"))).toBe((30 / 5) * 10);
  });

  it("shows the bucket's log-line count and preview in the hover tooltip", () => {
    const buckets = Array.from({ length: 3 }, (_, i) => bucket(i, 100));
    const line: DpsEvent = {
      ts: 11,
      kind: "damageOut",
      amount: 42,
      pilot: "Bob",
      ship: "Rifter",
      weapon: "AC II",
      quality: "Hits",
      ore: null,
      volume: 0,
    };
    const eventsByBucket = new Map<number, DpsEvent[]>([[10, [line]]]);
    const { container } = render(
      <BucketChart
        buckets={buckets}
        series={BUCKET_SERIES_OUT}
        eventsByBucket={eventsByBucket}
      />,
    );
    const svg = container.querySelector("svg")!;
    // jsdom has no PointerEvent — a MouseEvent with the pointermove type
    // carries clientX and still reaches React's onPointerMove listener.
    fireEvent(
      svg,
      new MouseEvent("pointermove", { bubbles: true, clientX: 25 }),
    ); // cell 2 → bucket start 10
    expect(screen.getByTestId("bucket-tooltip").textContent).toContain(
      "Log · 1 line",
    );
    expect(screen.getByTestId("bucket-tooltip").textContent).toContain("Bob");
  });
});
