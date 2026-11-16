import type { SeriesKey } from "./dpsMeterShared";

/** How loud a value reads. `normal` is the series' own colour; the other two
 *  are the shared semantic colours, so they follow the theme (#1213) instead
 *  of baking in a hex. */
export type ThresholdLevel = "normal" | "warn" | "danger";

/** One user-set alarm step: at or above `atOrAbove` (per second, in the
 *  series' own units), the readout reads at `level`. */
export interface Threshold {
  atOrAbove: number;
  level: Exclude<ThresholdLevel, "normal">;
}

/** Per-series alarm steps. A series with no entry (or an empty list) always
 *  reads `normal` — thresholds are opt-in. */
export type SeriesThresholds = Partial<Record<SeriesKey, Threshold[]>>;

/**
 * The level `value` falls into: the highest threshold it reaches wins, and a
 * value exactly on a threshold already counts as crossed (an 800 DPS alarm
 * fires at 800). Input order doesn't matter.
 */
export function levelFor(
  value: number,
  thresholds: Threshold[] | undefined,
): ThresholdLevel {
  let level: ThresholdLevel = "normal";
  let best = -Infinity;
  for (const t of thresholds ?? []) {
    if (value >= t.atOrAbove && t.atOrAbove > best) {
      best = t.atOrAbove;
      level = t.level;
    }
  }
  return level;
}

/** The one-click preset the issue asks for (#1270): a warning as incoming
 *  damage gets real, an alarm at the point most sub-capitals want to be
 *  leaving. */
export const INCOMING_ALARM: SeriesThresholds = {
  dpsIn: [
    { atOrAbove: 300, level: "warn" },
    { atOrAbove: 800, level: "danger" },
  ],
};

/** Text colour per level; `normal` keeps the series' own colour, so callers
 *  only use these two. */
export const LEVEL_TEXT: Record<Exclude<ThresholdLevel, "normal">, string> = {
  warn: "text-amber-400",
  danger: "text-rose-400",
};

/** Card border per level (`normal` keeps the default zinc border). */
export const LEVEL_BORDER: Record<Exclude<ThresholdLevel, "normal">, string> = {
  warn: "border-amber-500/60",
  danger: "border-rose-500/70",
};

/** SVG stroke per level, for the charts' guide lines. */
export const LEVEL_STROKE: Record<Exclude<ThresholdLevel, "normal">, string> = {
  warn: "var(--color-amber-500)",
  danger: "var(--color-rose-500)",
};
