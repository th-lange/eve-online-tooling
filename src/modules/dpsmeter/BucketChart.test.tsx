import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BucketChart } from "./BucketChart";
import { BUCKET_SERIES_OUT } from "./dpsMeterShared";
import type { DpsBucket, DpsEvent } from "../../lib/api";

// A ResizeObserver that reports a fixed viewport width to the chart (jsdom's
// elements all measure 0 and the global stub never fires a callback).
function stubResizeObserver(width: number) {
  const real = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb(
        [{ contentRect: { width } } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = real;
  };
}

let restoreRO: (() => void) | undefined;
afterEach(() => {
  restoreRO?.();
  restoreRO = undefined;
});

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

  it("fills the viewport width for a short session (no wasted room)", () => {
    restoreRO = stubResizeObserver(800);
    const buckets = Array.from({ length: 20 }, (_, i) => bucket(i, 100));
    const { container } = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} />,
    );
    // 20 buckets × 10px floor = 200px ≪ 800px viewport, so the SVG expands to
    // fill the full width instead of leaving ~3/4 empty.
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("800");
  });

  it("overflows (scrolls) only once buckets hit the min width", () => {
    restoreRO = stubResizeObserver(800);
    const buckets = Array.from({ length: 200 }, (_, i) => bucket(i, 100));
    const { container } = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} />,
    );
    // 200 × 10px = 2000px > 800px viewport: the floor binds and the chart
    // grows past the viewport to scroll (sticking to the live edge).
    expect(container.querySelector("svg")!.getAttribute("width")).toBe("2000");
  });

  it("highlights the single bucket closest to markTs, snapping past the end", () => {
    // 5 buckets: starts 0,5,10,15,20. markTs=12 is closest to bucket 10;
    // markTs far past the end snaps to the last bucket (20).
    const buckets = Array.from({ length: 5 }, (_, i) => bucket(i, 100));
    const mid = render(
      <BucketChart buckets={buckets} series={BUCKET_SERIES_OUT} markTs={12} />,
    );
    const midRect = mid.container.querySelector('rect[fill="#818cf8"]')!;
    expect(Number(midRect.getAttribute("x"))).toBe((10 / 5) * 10); // bucket 10
    expect(Number(midRect.getAttribute("width"))).toBe(10); // one bucket wide

    const end = render(
      <BucketChart
        buckets={buckets}
        series={BUCKET_SERIES_OUT}
        markTs={9999}
      />,
    );
    const endRect = end.container.querySelector('rect[fill="#818cf8"]')!;
    expect(Number(endRect.getAttribute("x"))).toBe((20 / 5) * 10); // last bucket
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

  it("draws the in-progress ghost cell dashed and highlights it when the cursor names it", () => {
    const buckets = Array.from({ length: 5 }, (_, i) => bucket(i, 100));
    const { container } = render(
      <BucketChart
        buckets={buckets}
        series={BUCKET_SERIES_OUT}
        ghost={{ start: 25, damageOut: 50, damageIn: 0 }}
        markTs={26}
      />,
    );
    // Dashed ghost outline at the cell past the last real bucket.
    const dashed = container.querySelector('rect[stroke-dasharray="3 3"]')!;
    expect(Number(dashed.getAttribute("x"))).toBe((25 / 5) * 10 + 1);
    // The cursor (26 → bucket 25) lands on the ghost, not the last real one.
    const mark = container.querySelector('rect[fill="#818cf8"]')!;
    expect(Number(mark.getAttribute("x"))).toBe((25 / 5) * 10);
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
