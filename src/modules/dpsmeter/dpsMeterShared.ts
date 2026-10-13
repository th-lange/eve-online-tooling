import type { DpsBucket, DpsEvent, DpsTick } from "../../lib/api";
import { formatInt } from "../../lib/format";

export type Mode = "live" | "playback";

/** How the two damage series are laid out: two panels side by side, two
 *  panels stacked vertically, or both overlaid in one combined panel. */
export type ChartLayout = "side" | "stacked" | "combined";

/** Readout formatting: keep one decimal under 100 (so small logi/cap/mining
 *  rates aren't lost to rounding — a 4.6 rep/s no longer reads as "5"), plain
 *  thousands-separated integer above. */
export function formatRate(v: number): string {
  if (v <= 0) return "0";
  return v < 100 ? v.toFixed(1) : formatInt(Math.round(v));
}

/** Compact local date/time for a gamelog's mtime, e.g. "Aug 6, 15:32" — so
 *  picking a file from the list tells you which session it was (#dps-search). */
export function formatLogDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Bare time-of-day for a playback timestamp, e.g. "15:32:07" — playback
 *  never spans more than one gamelog session, so the date doesn't matter. */
export function formatClock(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// How many ticks to keep on screen (~2 min at the 500 ms backend cadence).
export const BUFFER = 240;

// The series we graph + read out. `out` series share warm colours, `in` cool.
export const SERIES = [
  { key: "dpsOut", label: "DPS out", color: "#34d399", primary: true },
  { key: "dpsIn", label: "DPS in", color: "#f87171", primary: true },
  { key: "logiOut", label: "Logi out", color: "#38bdf8", primary: false },
  { key: "logiIn", label: "Logi in", color: "#a78bfa", primary: false },
  {
    key: "capWarfareOut",
    label: "Cap warfare out",
    color: "#fbbf24",
    primary: false,
  },
  {
    key: "capWarfareIn",
    label: "Cap warfare in",
    color: "#fb923c",
    primary: false,
  },
  {
    key: "capTransferOut",
    label: "Cap xfer out",
    color: "#2dd4bf",
    primary: false,
  },
  {
    key: "capTransferIn",
    label: "Cap xfer in",
    color: "#c084fc",
    primary: false,
  },
] as const satisfies readonly {
  key: keyof DpsTick;
  label: string;
  color: string;
  primary: boolean;
}[];

/** A chart line: identity + colour + a per-tick value accessor. The accessor
 *  lets the same chart draw aggregate series (tick fields) and per-source
 *  series (rows inside `byPilot`) without special-casing either. */
export type ChartSeries = {
  id: string;
  color: string;
  primary: boolean;
  get: (t: DpsTick) => number;
};

/** Series drawn on the outgoing (dealt) chart. */
export const SERIES_OUT: ChartSeries[] = SERIES.filter((s) =>
  (
    ["dpsOut", "logiOut", "capWarfareOut", "capTransferOut"] as string[]
  ).includes(s.key),
).map((s) => ({
  id: s.key,
  color: s.color,
  primary: s.primary,
  get: (t) => t[s.key],
}));
/** Series drawn on the incoming (taken) chart. */
export const SERIES_IN: ChartSeries[] = SERIES.filter((s) =>
  (["dpsIn", "logiIn", "capWarfareIn", "capTransferIn"] as string[]).includes(
    s.key,
  ),
).map((s) => ({
  id: s.key,
  color: s.color,
  primary: s.primary,
  get: (t) => t[s.key],
}));

// Width of one fixed detail-timeline bucket (s) — mirrors the backend's grid
// (#983). Buckets are epoch-aligned: start = ts - ts % BUCKET_SECS.
export const BUCKET_SECS = 5;

/** Epoch-aligned start of the 5 s bucket containing `ts`. */
export function bucketStartOf(ts: number): number {
  return Math.floor(ts / BUCKET_SECS) * BUCKET_SECS;
}

/** A bucket chart line: identity + colour + a per-bucket **rate** accessor
 *  (bucket fields are absolute sums; rate = sum / BUCKET_SECS). Mirrors
 *  {@link ChartSeries} on the fixed grid. */
export type BucketSeries = {
  id: string;
  color: string;
  primary: boolean;
  get: (b: DpsBucket) => number;
};

// Same palette/ordering as SERIES, keyed to bucket sum fields.
const BUCKET_FIELD: Record<string, keyof DpsBucket> = {
  dpsOut: "damageOut",
  dpsIn: "damageIn",
  logiOut: "repOut",
  logiIn: "repIn",
  capWarfareOut: "capWarfareOut",
  capWarfareIn: "capWarfareIn",
  capTransferOut: "capTransferOut",
  capTransferIn: "capTransferIn",
};

function bucketSeries(keys: string[]): BucketSeries[] {
  return SERIES.filter((s) => keys.includes(s.key)).map((s) => ({
    id: s.key,
    color: s.color,
    primary: s.primary,
    get: (b) => (b[BUCKET_FIELD[s.key]] as number) / BUCKET_SECS,
  }));
}

/** Bucket series for the outgoing (dealt) chart. */
export const BUCKET_SERIES_OUT: BucketSeries[] = bucketSeries([
  "dpsOut",
  "logiOut",
  "capWarfareOut",
  "capTransferOut",
]);
/** Bucket series for the incoming (taken) chart. */
export const BUCKET_SERIES_IN: BucketSeries[] = bucketSeries([
  "dpsIn",
  "logiIn",
  "capWarfareIn",
  "capTransferIn",
]);
/** Both directions overlaid, for the combined layout. */
export const BUCKET_SERIES_COMBINED: BucketSeries[] = [
  ...BUCKET_SERIES_OUT,
  ...BUCKET_SERIES_IN,
];

/** Append a batch of finalized buckets. The whole session is kept (12/min —
 *  trivial), so the detail chart can scroll over all of it; no ring buffer. */
export function appendBuckets(
  prev: DpsBucket[],
  batch: DpsBucket[],
): DpsBucket[] {
  return batch.length === 0 ? prev : prev.concat(batch);
}

// Palette for per-source (by-pilot) lines — distinct hues, assigned to each
// source on first sighting and kept for the session so a source never changes
// colour mid-fight. Wraps past 10 concurrent sources.
export const SOURCE_COLORS = [
  "#60a5fa", // blue
  "#f472b6", // pink
  "#4ade80", // green
  "#facc15", // yellow
  "#22d3ee", // cyan
  "#fb923c", // orange
  "#a78bfa", // violet
  "#f87171", // red
  "#2dd4bf", // teal
  "#e879f9", // fuchsia
];

/** Append a tick to the rolling buffer, dropping the oldest past `BUFFER`. */
export function appendTick(prev: DpsTick[], t: DpsTick): DpsTick[] {
  const next = prev.length >= BUFFER ? prev.slice(1) : prev.slice();
  next.push(t);
  return next;
}

// How many combat-log lines to keep on screen — generous enough to scroll
// back through a real fight without unbounded memory growth.
export const LOG_BUFFER = 500;

/** Append a batch of combat-log events (one `dps://events` payload is
 *  everything a single poll parsed, so more than one often arrives at
 *  once) to the rolling log, dropping the oldest past `LOG_BUFFER`. */
export function appendEvents(prev: DpsEvent[], batch: DpsEvent[]): DpsEvent[] {
  const next = prev.concat(batch);
  return next.length > LOG_BUFFER ? next.slice(next.length - LOG_BUFFER) : next;
}

/** Index of the tick closest in time to `ts`, or `null` for an empty
 *  buffer. Projects a combat-log scroll position onto the rate chart's
 *  tick-indexed x-axis (charts space points by index, not by elapsed time,
 *  so a timestamp alone isn't a chart position without this). */
export function nearestTickIndex(ticks: DpsTick[], ts: number): number | null {
  if (ticks.length === 0) return null;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const diff = Math.abs(ticks[i].at - ts);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

// Finest mining bucket granularity (s). Volumes accumulate at this resolution;
// the panel's 30 s view merges adjacent pairs, so both intervals share one store.
export const MINING_BUCKET_SECS = 15;
// How many intervals the mining rate line shows.
export const MINING_BARS = 24;
// Trailing window (s) each mining-rate point averages over. Mining lasers book
// ore in cycle-sized chunks (a strip miner ~1000 m³ every ~60 s), so anything
// shorter than a cycle would show spikes instead of the sustained rate.
export const MINING_SMOOTH_SECS = 60;

/** Timeline swatch color per event category — reused from the primary
 *  readouts (dpsOut/dpsIn) and the mining panel's amber, so the same color
 *  means the same thing everywhere on this page. */
export const TIMELINE_COLORS = {
  damageOut: "#34d399",
  damageIn: "#f87171",
  mining: "#fcd34d",
} as const;
