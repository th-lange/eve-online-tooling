import type { DpsTick } from "../../lib/api";
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
