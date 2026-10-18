import { describe, expect, it } from "vitest";
import {
  appendBuckets,
  MAX_SESSION_BUCKETS,
  MAX_SESSION_EVENTS,
  minuteStartOf,
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

describe("minuteStartOf", () => {
  it("floors to the containing minute — the shared log ⇄ chart cursor id", () => {
    expect(minuteStartOf(3600)).toBe(3600);
    expect(minuteStartOf(3659)).toBe(3600);
    expect(minuteStartOf(3660)).toBe(3660);
  });
});

describe("appendBuckets", () => {
  it("never doubles the time axis on re-delivery", () => {
    const batch = [bkt(0), bkt(5)];
    const once = appendBuckets([], batch);
    expect(once.map((b) => b.start)).toEqual([0, 5]);
    // The same batch delivered again (a leaked duplicate listener, a replayed
    // payload) replaces in place — the axis and log groups stay unique. This
    // is what made the chart line stop mid-panel and the log double.
    expect(appendBuckets(once, batch).map((b) => b.start)).toEqual([0, 5]);
    // Overlapping delivery appends only the genuinely new tail.
    const next = appendBuckets(once, [bkt(5), bkt(10)]);
    expect(next.map((b) => b.start)).toEqual([0, 5, 10]);
  });

  it("applies a backend amendment: same id replaces the kept bucket", () => {
    const prev = appendBuckets([], [bkt(0), bkt(5), bkt(10)]);
    // A late-flushed line re-opened bucket 5 — it is re-emitted with
    // updated sums; the kept copy is replaced, nothing is appended.
    const amended = { ...bkt(5), damageOut: 999 };
    const next = appendBuckets(prev, [amended]);
    expect(next.map((b) => b.start)).toEqual([0, 5, 10]);
    expect(next[1].damageOut).toBe(999);
  });

  it("appends normally in order and is a no-op for an empty batch", () => {
    const prev = [bkt(0)];
    expect(appendBuckets(prev, [])).toBe(prev);
    expect(appendBuckets(prev, [bkt(5)]).map((b) => b.start)).toEqual([0, 5]);
  });

  it("drops the oldest buckets past the session backstop (#1064)", () => {
    const full = Array.from({ length: MAX_SESSION_BUCKETS }, (_, i) =>
      bkt(i * 5),
    );
    const next = appendBuckets(full, [bkt(MAX_SESSION_BUCKETS * 5)]);
    expect(next).toHaveLength(MAX_SESSION_BUCKETS);
    // Oldest fell off, newest kept.
    expect(next[0].start).toBe(5);
    expect(next[next.length - 1].start).toBe(MAX_SESSION_BUCKETS * 5);
  });

  it("compacts oldest buckets' events past the event budget (#1064)", () => {
    const ev: DpsBucket["events"][number] = {
      ts: 0,
      kind: "damage_out",
      amount: 1,
      pilot: null,
      ship: null,
      weapon: null,
      quality: null,
      ore: null,
      volume: 0,
    };
    const heavy = (start: number, n: number) => ({
      ...bkt(start),
      events: Array.from({ length: n }, () => ev),
    });
    // Two kept buckets at the budget, then one more event arrives: the
    // OLDEST bucket is compacted to aggregates-only; the chart span (bucket
    // count and sums) is untouched.
    const prev = appendBuckets(
      [],
      [heavy(0, MAX_SESSION_EVENTS / 2), heavy(5, MAX_SESSION_EVENTS / 2)],
    );
    const next = appendBuckets(prev, [heavy(10, 1)]);
    expect(next.map((b) => b.start)).toEqual([0, 5, 10]);
    expect(next[0].events).toHaveLength(0);
    expect(next[1].events).toHaveLength(MAX_SESSION_EVENTS / 2);
    expect(next[2].events).toHaveLength(1);
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
