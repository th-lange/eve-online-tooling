import type { DpsBucket, DpsEvent, DpsOverviewSegment } from "../../lib/api";
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

/** The rate series the page graphs + reads out. Each maps to an absolute
 *  bucket sum field via {@link BUCKET_FIELD}; the rate is sum / BUCKET_SECS. */
export type SeriesKey =
  | "dpsOut"
  | "dpsIn"
  | "logiOut"
  | "logiIn"
  | "capWarfareOut"
  | "capWarfareIn"
  | "capTransferOut"
  | "capTransferIn";

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
  key: SeriesKey;
  label: string;
  color: string;
  primary: boolean;
}[];

// Width of one fixed detail-timeline bucket (s) — mirrors the backend's grid
// (#983). Buckets are epoch-aligned: start = ts - ts % BUCKET_SECS.
export const BUCKET_SECS = 5;

/** Epoch-aligned start of the 5 s bucket containing `ts`. */
export function bucketStartOf(ts: number): number {
  return Math.floor(ts / BUCKET_SECS) * BUCKET_SECS;
}

/** Start of the bucket whose time is closest to `ts` (by bucket midpoint), or
 *  `null` if there are no buckets. The combat log runs ahead of the chart
 *  (buckets finalize only once their 5 s window closes), so a log line can
 *  point past the newest bucket — this snaps to the nearest existing one, the
 *  single segment the chart highlights for the log's centre line. */
export function nearestBucketStart(
  buckets: DpsBucket[],
  ts: number,
): number | null {
  if (buckets.length === 0) return null;
  let best = buckets[0].start;
  let bestDiff = Infinity;
  for (const b of buckets) {
    const diff = Math.abs(b.start + BUCKET_SECS / 2 - ts);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = b.start;
    }
  }
  return best;
}

// Buckets in the centered smoothing window for the rate charts. A single
// volley lands entirely in one 5 s bucket, so the raw per-bucket rate swings
// between a tall spike and zero on the next bucket; averaging over a small
// window turns that into a readable trend. Odd so the window is symmetric
// around each bucket; 3 ≈ a 15 s moving average (close to the old rolling
// readout) while staying responsive.
export const SMOOTH_WINDOW_BUCKETS = 3;

/** Centered moving average of `values` over {@link SMOOTH_WINDOW_BUCKETS},
 *  clamped at the ends (each point averages only the neighbours that exist).
 *  Pure **display** smoothing for the rate lines — the underlying bucket data
 *  is untouched, so tooltips, peaks and the y-axis still read true rates. */
export function smoothSeries(values: number[]): number[] {
  const r = Math.floor(SMOOTH_WINDOW_BUCKETS / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - r);
    const hi = Math.min(values.length - 1, i + r);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += values[j];
    return sum / (hi - lo + 1);
  });
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
const BUCKET_FIELD: Record<SeriesKey, keyof DpsBucket> = {
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

// Combat-log line cap for the PVP fight overlay's footer — a fight is
// bounded (the bucket buffer freezes at 10 min), so a rolling window is
// plenty there. The DPS meter page keeps the whole session uncapped so the
// log always covers the same span as the bucket chart (#1001).
export const LOG_BUFFER = 500;

/** Append a batch of combat-log events (one `dps://events` payload is
 *  everything a single poll parsed, so more than one often arrives at once).
 *  With `cap` set, the oldest lines past it are dropped (the fight overlay's
 *  rolling footer); without it the log keeps the whole session, in lockstep
 *  with the unbounded bucket buffer (#1001). */
export function appendEvents(
  prev: DpsEvent[],
  batch: DpsEvent[],
  cap?: number,
): DpsEvent[] {
  const next = batch.length === 0 ? prev : prev.concat(batch);
  return cap != null && next.length > cap
    ? next.slice(next.length - cap)
    : next;
}

/** The session's events grouped onto the 5 s bucket grid, in time order —
 *  the shared identity between the combat log and the charts (#1000): group
 *  `start` is the bucket id (`bucketStartOf`), so a log group, a chart
 *  bucket, and the cursor all name the same thing. */
export type EventBucketGroup = { start: number; events: DpsEvent[] };

export function groupEventsByBucket(events: DpsEvent[]): EventBucketGroup[] {
  const groups: EventBucketGroup[] = [];
  for (const ev of events) {
    const start = bucketStartOf(ev.ts);
    const last = groups[groups.length - 1];
    if (last && last.start === start) {
      last.events.push(ev);
    } else {
      groups.push({ start, events: [ev] });
    }
  }
  return groups;
}

/** The in-progress bucket at the live edge (#1004): the newest events arrive
 *  up to ~5 s before the bucket covering them finalizes, so the chart draws
 *  this as a dashed ghost cell. Sums damage out/in over the events inside the
 *  newest event's bucket; `null` when that bucket already exists on the chart
 *  (`lastEnd` = the last finalized bucket's end) or there are no events. */
export type GhostBucket = {
  start: number;
  damageOut: number;
  damageIn: number;
};

export function pendingGhostBucket(
  events: DpsEvent[],
  lastEnd: number | null,
): GhostBucket | null {
  const newest = events[events.length - 1];
  if (!newest) return null;
  const start = bucketStartOf(newest.ts);
  if (lastEnd != null && start < lastEnd) return null;
  let damageOut = 0;
  let damageIn = 0;
  // Events are time-ordered; walk back only as far as the ghost's bucket.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.ts < start) break;
    if (ev.kind === "damageOut") damageOut += ev.amount;
    else if (ev.kind === "damageIn") damageIn += ev.amount;
  }
  return { start, damageOut, damageIn };
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

// --- Overview segments (#985): fixed 1-minute grid, 10^x auto-fit zoom ---

/** Width of one base overview segment (s) — mirrors the backend's grid. */
export const OVERVIEW_SEGMENT_SECS = 60;
/** Most bars the strip draws: the auto-fit picks the smallest 10^x-minute
 *  grouping that stays under this (960 logical px ÷ ~6 px per bar). */
export const OVERVIEW_MAX_BARS = 160;

/** The grouping width (s) for a window: the smallest `60 × 10^x` whose bar
 *  count fits the strip. 1 minute is the floor; levels only step in powers
 *  of ten (1 min → 10 min → 100 min → …). */
export function overviewGroupSecs(windowSecs: number): number {
  let g = OVERVIEW_SEGMENT_SECS;
  while (Math.ceil(Math.max(1, windowSecs) / g) > OVERVIEW_MAX_BARS) {
    g *= 10;
  }
  return g;
}

/** Snap a window outward to whole group edges at width `groupSecs`. */
export function snapWindow(
  start: number,
  end: number,
  groupSecs: number,
): { start: number; end: number } {
  const s = Math.floor(start / groupSecs) * groupSecs;
  const e = Math.ceil(Math.max(end, start + 1) / groupSecs) * groupSecs;
  return { start: s, end: e };
}

/** Sum the base 1-minute segments into contiguous groups of `groupSecs`
 *  covering `[winStart, winEnd)` (both multiples of `groupSecs`). Minutes
 *  with no segment (outside the log, or idle) contribute zero, so the bar
 *  count is pure arithmetic: `(winEnd - winStart) / groupSecs`. */
export function groupOverview(
  segments: DpsOverviewSegment[],
  winStart: number,
  winEnd: number,
  groupSecs: number,
): DpsOverviewSegment[] {
  const count = Math.max(1, Math.round((winEnd - winStart) / groupSecs));
  const groups: DpsOverviewSegment[] = Array.from(
    { length: count },
    (_, i) => ({
      start: winStart + i * groupSecs,
      damageOut: 0,
      damageIn: 0,
      mining: 0,
    }),
  );
  for (const s of segments) {
    if (s.start < winStart || s.start >= winEnd) continue;
    const g = groups[Math.floor((s.start - winStart) / groupSecs)];
    g.damageOut += s.damageOut;
    g.damageIn += s.damageIn;
    g.mining += s.mining;
  }
  return groups;
}
