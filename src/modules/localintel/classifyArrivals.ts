import type { LocalPilot } from "../../lib/api";

/** Which class of arrival triggered the notice, in priority order (watchlist
 *  beats red beats opt-in neutral) — mirrors the `notify()` titles in
 *  LocalIntelPage's scan `onSuccess`. */
export type ArrivalNoticeKind = "watchlist" | "red" | "neutral";

export interface ArrivalNotice {
  kind: ArrivalNoticeKind;
  pilots: LocalPilot[];
}

export interface ClassifyArrivalsOptions {
  alertAnyRed: boolean;
  alertNeutrals: boolean;
}

export interface ClassifyArrivalsResult {
  /** Pilot ids new since `prevIds` (first scan: everyone is "new"). */
  newIds: Set<number>;
  /** The single highest-priority notice to raise, or null if nothing
   *  qualifies. Only one notice ever fires per scan — watchlist beats red
   *  beats opt-in neutral, matching the original `else if` chain. */
  notice: ArrivalNotice | null;
  /** Whether the alarm sound should play — same qualifying condition as
   *  `notice`, but true even for classes that share priority (kept distinct
   *  from `notice` for clarity, though today it's equivalent). */
  alarm: boolean;
}

/**
 * Pure classification of a scan result against the previous scan's pilot
 * ids: which pilots just arrived, and whether they warrant an alert.
 *
 * Priority is watchlist > red (opt-in) > neutral (opt-in) — a watchlisted
 * pilot arriving alongside a red pilot only raises the watchlist notice; the
 * red arrival is silently swallowed for that scan. This matches the current
 * `else if` chain in LocalIntelPage and is preserved intentionally.
 *
 * On the first scan (`prevIds` empty), every pilot is "new" and therefore
 * apt to trigger alerts — this is existing behavior, not a bug.
 */
export function classifyArrivals(
  prevIds: Set<number>,
  pilots: LocalPilot[],
  watchIds: Set<number>,
  opts: ClassifyArrivalsOptions,
): ClassifyArrivalsResult {
  const newIds = new Set(
    pilots.filter((p) => !prevIds.has(p.characterId)).map((p) => p.characterId),
  );
  const isWatch = (p: LocalPilot) =>
    watchIds.has(p.corporationId) ||
    (p.allianceId != null && watchIds.has(p.allianceId));
  const arrivals = pilots.filter((p) => newIds.has(p.characterId));
  const newWatched = arrivals.filter(isWatch);
  const newReds = arrivals.filter((p) => p.threat === "red");
  const newNeutrals = arrivals.filter((p) => p.threat === "neutral");

  let notice: ArrivalNotice | null = null;
  if (newWatched.length > 0) {
    notice = { kind: "watchlist", pilots: newWatched };
  } else if (opts.alertAnyRed && newReds.length > 0) {
    notice = { kind: "red", pilots: newReds };
  } else if (opts.alertNeutrals && newNeutrals.length > 0) {
    notice = { kind: "neutral", pilots: newNeutrals };
  }

  const alarm =
    newWatched.length > 0 ||
    (opts.alertAnyRed && newReds.length > 0) ||
    (opts.alertNeutrals && newNeutrals.length > 0);

  return { newIds, notice, alarm };
}
