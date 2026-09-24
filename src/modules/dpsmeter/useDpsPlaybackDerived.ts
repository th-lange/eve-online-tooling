import { useMemo, useRef } from "react";
import type { DpsTick } from "../../lib/api";
import {
  MINING_BARS,
  MINING_BUCKET_SECS,
  MINING_SMOOTH_SECS,
  SERIES_IN,
  SERIES_OUT,
  SOURCE_COLORS,
  type ChartSeries,
} from "./dpsMeterShared";

/** Derived per-tick stats: pilot classification/colouring, chart series
 *  (aggregate or by-source), the pilot filter, and the mining rate series —
 *  all recomputed from the rolling `ticks` buffer + the mining accumulator
 *  ref owned by {@link ../useDpsPlaybackState.useDpsPlaybackState}. */
export function useDpsPlaybackDerived({
  ticks,
  latest,
  selectedPilot,
  bySource,
  miningInterval,
  miningRef,
}: {
  ticks: DpsTick[];
  latest: DpsTick | undefined;
  selectedPilot: string | null;
  bySource: boolean;
  miningInterval: 15 | 30;
  miningRef: React.RefObject<{
    buckets: Map<number, number>;
    lastAt: number | null;
  }>;
}) {
  // Collect every pilot name seen across the whole buffer so buttons stay
  // visible even after a pilot ages out of the rolling window.
  const knownPilots = useMemo(
    () =>
      [...new Set(ticks.flatMap((t) => t.byPilot.map((p) => p.name)))].sort(),
    [ticks],
  );

  // Stable per-source colours: assigned from SOURCE_COLORS the first time a
  // name is seen and kept for the session (a Map, not per-buffer, so a source
  // that ages out of the rolling window and returns keeps its colour).
  const sourceColorsRef = useRef(new Map<string, string>());
  const sourceColors = sourceColorsRef.current;
  for (const name of knownPilots) {
    if (!sourceColors.has(name)) {
      sourceColors.set(
        name,
        SOURCE_COLORS[sourceColors.size % SOURCE_COLORS.length],
      );
    }
  }

  // Per-source chart series (by-source mode): one line per counterparty —
  // damage dealt to them on the Outgoing chart, taken from them on Incoming.
  // A selected pilot narrows the breakdown to just that engagement.
  const { outSeries, inSeries } = useMemo(() => {
    if (!bySource) return { outSeries: SERIES_OUT, inSeries: SERIES_IN };
    const names = selectedPilot
      ? knownPilots.filter((n) => n === selectedPilot)
      : knownPilots;
    const mk = (field: "dpsOut" | "dpsIn"): ChartSeries[] =>
      names.map((name) => ({
        id: name,
        color: sourceColorsRef.current.get(name) ?? SOURCE_COLORS[0],
        primary: true,
        get: (t) => t.byPilot.find((p) => p.name === name)?.[field] ?? 0,
      }));
    return { outSeries: mk("dpsOut"), inSeries: mk("dpsIn") };
  }, [bySource, knownPilots, selectedPilot]);

  // Combined layout: both series in one panel. Suffix the ids so out/in lines
  // never collide on their React key (they share the pilot name in by-source
  // mode), keeping colours as-is (green/red totals, or per-pilot).
  const combinedSeries = useMemo(
    () => [
      ...outSeries.map((s) => ({ ...s, id: `${s.id} out` })),
      ...inSeries.map((s) => ({ ...s, id: `${s.id} in` })),
    ],
    [outSeries, inSeries],
  );

  // When a pilot is selected, replace the aggregate dpsOut/dpsIn on each tick
  // with that pilot's per-engagement values so the charts reflect the filter.
  // All other series (logi, cap, mining) are not per-pilot and stay unchanged.
  const filteredTicks = useMemo(() => {
    if (!selectedPilot) return ticks;
    return ticks.map((t) => {
      const p = t.byPilot.find((r) => r.name === selectedPilot);
      return { ...t, dpsOut: p?.dpsOut ?? 0, dpsIn: p?.dpsIn ?? 0 };
    });
  }, [ticks, selectedPilot]);

  const filteredLatest = filteredTicks[filteredTicks.length - 1];

  // byPilot rows scoped to the selection (all rows when unfiltered).
  const pilotRows = selectedPilot
    ? (latest?.byPilot.filter((p) => p.name === selectedPilot) ?? [])
    : (latest?.byPilot ?? []);

  // Tackle status from the newest tick: who is holding you down (scram/point
  // in) and who you are holding (out). Drives the warning banner.
  const tackledBy = latest?.byPilot.filter((p) => p.scramIn || p.pointIn) ?? [];
  const tackling =
    latest?.byPilot.filter((p) => p.scramOut || p.pointOut) ?? [];

  // Mining overview: session total + a normalized rate series over the last
  // MINING_BARS intervals ending at the newest tick. Mining lasers deliver ore
  // in cycle-sized chunks (a strip miner books ~1000 m³ every ~60 s), so the
  // raw per-interval volumes are spiky; each point is instead a trailing
  // average over MINING_SMOOTH_SECS of buckets — chunky input, steady line.
  // The in-progress interval is divided by its elapsed time (not the full
  // step) so the line doesn't droop at the right edge while a bucket fills.
  // Recomputed per tick (`latest` changes) — the buckets live in a ref, so
  // `latest` is the reactive trigger here.
  const { miningPoints, miningTotal } = useMemo(() => {
    const buckets = miningRef.current.buckets;
    let miningTotal = 0;
    for (const v of buckets.values()) miningTotal += v;
    if (miningTotal <= 0 || !latest) {
      return {
        miningPoints: [] as { age: number; rate: number }[],
        miningTotal,
      };
    }
    const step = miningInterval;
    const end = Math.floor(latest.at / step) * step;
    // Raw m³ per interval (30 s = two 15 s buckets merged).
    const raw = Array.from({ length: MINING_BARS }, (_, i) => {
      const t0 = end - (MINING_BARS - 1 - i) * step;
      let m3 = buckets.get(t0) ?? 0;
      if (step === 30) m3 += buckets.get(t0 + MINING_BUCKET_SECS) ?? 0;
      return m3;
    });
    const elapsedCur = Math.max(latest.at - end, 1);
    const span = Math.max(1, Math.round(MINING_SMOOTH_SECS / step));
    const miningPoints = raw.map((_, i) => {
      const j0 = Math.max(0, i - span + 1);
      let m3 = 0;
      for (let j = j0; j <= i; j++) m3 += raw[j];
      // Seconds actually covered: full steps for closed intervals, elapsed
      // time for the still-filling newest one.
      const secs =
        (i - j0) * step + (i === MINING_BARS - 1 ? elapsedCur : step);
      return { age: (MINING_BARS - 1 - i) * step, rate: m3 / secs };
    });
    return { miningPoints, miningTotal };
  }, [latest, miningInterval, miningRef]);

  return {
    knownPilots,
    sourceColors,
    outSeries,
    inSeries,
    combinedSeries,
    filteredTicks,
    filteredLatest,
    pilotRows,
    tackledBy,
    tackling,
    miningPoints,
    miningTotal,
  };
}
