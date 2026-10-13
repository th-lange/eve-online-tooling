import { describe, expect, it } from "vitest";
import {
  nearestBucketStart,
  SMOOTH_WINDOW_BUCKETS,
  smoothSeries,
} from "./dpsMeterShared";
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
function bkt(start: number): DpsBucket {
  return {
    start,
    end: start + 5,
    damageOut: 0,
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

describe("nearestBucketStart", () => {
  const buckets = [bkt(0), bkt(5), bkt(10)]; // midpoints 2.5, 7.5, 12.5
  it("picks the bucket whose midpoint is closest to the time", () => {
    expect(nearestBucketStart(buckets, 1)).toBe(0);
    expect(nearestBucketStart(buckets, 6)).toBe(5);
    expect(nearestBucketStart(buckets, 11)).toBe(10);
  });
  it("snaps a time past the end to the last bucket, before the start to the first", () => {
    expect(nearestBucketStart(buckets, 9999)).toBe(10);
    expect(nearestBucketStart(buckets, -9999)).toBe(0);
  });
  it("returns null for an empty chart", () => {
    expect(nearestBucketStart([], 100)).toBeNull();
  });
});

describe("smoothSeries", () => {
  it("averages each point with its immediate neighbours", () => {
    // Window of 3 → interior points average [i-1, i, i+1].
    expect(smoothSeries([0, 3, 0, 3, 0])).toEqual([
      1.5, // (0+3)/2 — left edge clamps to 2 values
      1, // (0+3+0)/3
      2, // (3+0+3)/3
      1, // (0+3+0)/3
      1.5, // (3+0)/2 — right edge clamps to 2 values
    ]);
  });

  it("flattens a lone spike into a lower, spread-out bump", () => {
    const raw = [0, 0, 100, 0, 0];
    const smooth = smoothSeries(raw);
    // The spike's peak is cut down and bleeds into its neighbours, so the
    // saw-tooth between a volley and the silent next bucket reads as a trend.
    expect(Math.max(...smooth)).toBeLessThan(Math.max(...raw));
    expect(smooth[1]).toBeGreaterThan(0);
    expect(smooth[3]).toBeGreaterThan(0);
    // Total "energy" is conserved for interior-only spikes.
    expect(smooth.reduce((a, b) => a + b, 0)).toBeCloseTo(100);
  });

  it("preserves length and leaves a flat series unchanged", () => {
    expect(smoothSeries([])).toEqual([]);
    expect(smoothSeries([7, 7, 7, 7])).toEqual([7, 7, 7, 7]);
  });

  it("uses an odd window so it stays symmetric around each point", () => {
    expect(SMOOTH_WINDOW_BUCKETS % 2).toBe(1);
  });
});
