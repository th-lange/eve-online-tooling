import { useMemo, useRef } from "react";
import type { DpsBucket, PilotRate } from "../../lib/api";
import {
  BUCKET_SECS,
  BUCKET_SERIES_IN,
  BUCKET_SERIES_OUT,
  MINING_BARS,
  MINING_BUCKET_SECS,
  MINING_SMOOTH_SECS,
  SOURCE_COLORS,
  type BucketSeries,
} from "./dpsMeterShared";

/** Per-second rates for the readout tiles, keyed like the SERIES list. */
export type LatestRates = {
  dpsOut: number;
  dpsIn: number;
  logiOut: number;
  logiIn: number;
  capWarfareOut: number;
  capWarfareIn: number;
  capTransferOut: number;
  capTransferIn: number;
};

/** Derived per-bucket stats (#984): pilot classification/colouring, chart
 *  series (aggregate or by-source), the pilot filter, readout rates, session
 *  peaks, tackle status, and the mining rate series — all recomputed from the
 *  session's bucket list owned by
 *  {@link ../useDpsPlaybackState.useDpsPlaybackState}. */
export function useDpsPlaybackDerived({
  buckets,
  selectedPilot,
  bySource,
  miningInterval,
}: {
  buckets: DpsBucket[];
  selectedPilot: string | null;
  bySource: boolean;
  miningInterval: 15 | 30;
}) {
  const latestBucket = buckets[buckets.length - 1];

  // Collect every pilot name seen across the whole session so filter buttons
  // never disappear mid-fight.
  const knownPilots = useMemo(
    () =>
      [...new Set(buckets.flatMap((b) => b.byPilot.map((p) => p.name)))].sort(),
    [buckets],
  );

  // Stable per-source colours: assigned from SOURCE_COLORS the first time a
  // name is seen and kept for the session.
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

  // Chart series over the bucket grid. Aggregate mode scopes the two damage
  // series to the selected pilot (logi/cap are not per-pilot and stay global);
  // by-source mode draws one line per counterparty instead.
  const { outSeries, inSeries } = useMemo(() => {
    const pilotRate = (name: string, field: "dpsOut" | "dpsIn") => {
      return (b: DpsBucket) =>
        b.byPilot.find((p) => p.name === name)?.[field] ?? 0;
    };
    if (!bySource) {
      if (!selectedPilot) {
        return { outSeries: BUCKET_SERIES_OUT, inSeries: BUCKET_SERIES_IN };
      }
      const scope = (list: BucketSeries[], field: "dpsOut" | "dpsIn") =>
        list.map((s) =>
          s.id === field ? { ...s, get: pilotRate(selectedPilot, field) } : s,
        );
      return {
        outSeries: scope(BUCKET_SERIES_OUT, "dpsOut"),
        inSeries: scope(BUCKET_SERIES_IN, "dpsIn"),
      };
    }
    const names = selectedPilot
      ? knownPilots.filter((n) => n === selectedPilot)
      : knownPilots;
    const mk = (field: "dpsOut" | "dpsIn"): BucketSeries[] =>
      names.map((name) => ({
        id: name,
        color: sourceColorsRef.current.get(name) ?? SOURCE_COLORS[0],
        primary: true,
        get: pilotRate(name, field),
      }));
    return { outSeries: mk("dpsOut"), inSeries: mk("dpsIn") };
  }, [bySource, knownPilots, selectedPilot]);

  // Combined layout: both series in one panel. Suffix the ids so out/in lines
  // never collide on their React key (they share the pilot name in by-source
  // mode), keeping colours as-is.
  const combinedSeries = useMemo(
    () => [
      ...outSeries.map((s) => ({ ...s, id: `${s.id} out` })),
      ...inSeries.map((s) => ({ ...s, id: `${s.id} in` })),
    ],
    [outSeries, inSeries],
  );

  // Readout rates from the last finalized bucket — by construction identical
  // to the chart's newest point. A selected pilot scopes the two damage rates.
  const latestRates: LatestRates | undefined = useMemo(() => {
    if (!latestBucket) return undefined;
    const b = latestBucket;
    const pilot = selectedPilot
      ? b.byPilot.find((p) => p.name === selectedPilot)
      : undefined;
    return {
      dpsOut: selectedPilot ? (pilot?.dpsOut ?? 0) : b.damageOut / BUCKET_SECS,
      dpsIn: selectedPilot ? (pilot?.dpsIn ?? 0) : b.damageIn / BUCKET_SECS,
      logiOut: b.repOut / BUCKET_SECS,
      logiIn: b.repIn / BUCKET_SECS,
      capWarfareOut: b.capWarfareOut / BUCKET_SECS,
      capWarfareIn: b.capWarfareIn / BUCKET_SECS,
      capTransferOut: b.capTransferOut / BUCKET_SECS,
      capTransferIn: b.capTransferIn / BUCKET_SECS,
    };
  }, [latestBucket, selectedPilot]);

  // Session peaks: the busiest 5 s bucket so far (aggregate, not filtered).
  const { peakOut, peakIn } = useMemo(() => {
    let peakOut = 0;
    let peakIn = 0;
    for (const b of buckets) {
      peakOut = Math.max(peakOut, b.damageOut / BUCKET_SECS);
      peakIn = Math.max(peakIn, b.damageIn / BUCKET_SECS);
    }
    return { peakOut, peakIn };
  }, [buckets]);

  // byPilot rows scoped to the selection (all rows when unfiltered).
  const pilotRows: PilotRate[] = selectedPilot
    ? (latestBucket?.byPilot.filter((p) => p.name === selectedPilot) ?? [])
    : (latestBucket?.byPilot ?? []);

  // Tackle status from the newest bucket: who is holding you down (scram/
  // point in) and who you are holding (out). Drives the warning banner.
  const tackledBy =
    latestBucket?.byPilot.filter((p) => p.scramIn || p.pointIn) ?? [];
  const tackling =
    latestBucket?.byPilot.filter((p) => p.scramOut || p.pointOut) ?? [];

  // Mining overview: session total + a normalized rate series over the last
  // MINING_BARS intervals ending at the newest bucket. Mining lasers deliver
  // ore in cycle-sized chunks (a strip miner books ~1000 m³ every ~60 s), so
  // raw per-interval volumes are spiky; each point is a trailing average over
  // MINING_SMOOTH_SECS instead — chunky input, steady line. Derived straight
  // from the session's buckets (#984): 5 s buckets sum into the 15 s grid the
  // panel's two interval widths are built from.
  const { miningPoints, miningTotal, miningRate } = useMemo(() => {
    const grid = new Map<number, number>();
    let miningTotal = 0;
    for (const b of buckets) {
      if (b.miningM3 <= 0) continue;
      miningTotal += b.miningM3;
      const key = Math.floor(b.start / MINING_BUCKET_SECS) * MINING_BUCKET_SECS;
      grid.set(key, (grid.get(key) ?? 0) + b.miningM3);
    }
    const miningRate = latestBucket ? latestBucket.miningM3 / BUCKET_SECS : 0;
    if (miningTotal <= 0 || !latestBucket) {
      return {
        miningPoints: [] as { age: number; rate: number }[],
        miningTotal,
        miningRate,
      };
    }
    const step = miningInterval;
    const at = latestBucket.end;
    // The interval the newest bucket closed into; `at` on an exact interval
    // boundary means that interval just completed (elapsed = full step).
    const end = Math.floor((at - 1) / step) * step;
    const elapsedCur = Math.max(at - end, 1);
    // Raw m³ per interval (30 s = two 15 s grid cells merged).
    const raw = Array.from({ length: MINING_BARS }, (_, i) => {
      const t0 = end - (MINING_BARS - 1 - i) * step;
      let m3 = grid.get(t0) ?? 0;
      if (step === 30) m3 += grid.get(t0 + MINING_BUCKET_SECS) ?? 0;
      return m3;
    });
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
    return { miningPoints, miningTotal, miningRate };
  }, [buckets, latestBucket, miningInterval]);

  return {
    latestBucket,
    latestRates,
    knownPilots,
    sourceColors,
    outSeries,
    inSeries,
    combinedSeries,
    peakOut,
    peakIn,
    pilotRows,
    tackledBy,
    tackling,
    miningPoints,
    miningTotal,
    miningRate,
  };
}
