import type { DayTradeRow } from "../../lib/api";

/** Cargo-aware per-trip metrics for a hauler running a fixed-size hold. */
export interface TripMetrics {
  /** Units of this item that fit in one trip's cargo hold. */
  unitsPerTrip: number;
  /** Profit realized on a single trip (capped by the suggested quantity). */
  profitPerTrip: number;
  /** Trips needed to move the full suggested quantity. */
  trips: number;
}

/**
 * Cargo-aware per-trip metrics: how many units of `row` fit in one trip of
 * `cargoM3` m³, the profit on that trip, and how many trips are needed to
 * move the full suggested quantity (#602). `cargoM3 <= 0` means the feature
 * is off — callers should skip the derived columns entirely.
 */
export function tripMetrics(
  row: DayTradeRow,
  cargoM3: number,
): TripMetrics | null {
  if (cargoM3 <= 0) return null;
  const unitsPerTrip = Math.floor(cargoM3 / row.volumeM3);
  const profitPerTrip =
    Math.min(row.suggestedQty, unitsPerTrip) * row.profitPerUnit;
  const trips = Math.ceil((row.suggestedQty * row.volumeM3) / cargoM3);
  return { unitsPerTrip, profitPerTrip, trips };
}
