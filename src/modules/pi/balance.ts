//! Pure balance/runway derivations for the PI module. Kept out of `PIPage.tsx`
//! so that file exports only components (React Fast Refresh requirement) — and
//! so this logic stays unit-testable without a DOM.

import type { ColonyView } from "../../lib/api";

/** Treat rates within this of zero as break-even (float noise guard). */
export const EPS = 0.0001;

/** Total units and stored volume of a type id across a colony's storage pins. */
export function stockMaps(colony: ColonyView) {
  const stock = new Map<number, number>();
  const volume = new Map<number, number>();
  for (const s of colony.storage) {
    for (const c of s.contents) {
      stock.set(c.typeId, (stock.get(c.typeId) ?? 0) + c.amount);
      volume.set(c.typeId, (volume.get(c.typeId) ?? 0) + c.volume);
    }
  }
  return { stock, volume };
}

/** A commodity is "banking" (worth easing off) once it alone ties up this much
 *  of the colony's total storage capacity, even if its instantaneous balance
 *  isn't net-positive (e.g. a starved factory stopped consuming it). */
const BANK_VOLUME_SHARE = 0.15;

/** Recommend how to re-aim extraction next cycle. Balance `net` (produced −
 *  consumed per hour) alone only says which way a commodity is trending — it
 *  misses that PI is bursty: what actually matters next cycle is what's about
 *  to run OUT (a near-empty stock drains fast even off a mild deficit) versus
 *  what's already piled up (a big stockpile means "stop feeding it" even if
 *  its rate looks balanced, e.g. a factory stalled on a missing input). So:
 *  - "feed": net-negative inputs, ranked by runway (stock ÷ deficit) — lowest
 *    runway (closest to empty) first, regardless of how large the deficit is.
 *  - "ease off": extracted P0s that are either net-positive OR already
 *    hogging a big share of colony storage, ranked by stockpile size.
 */
export function extractionAdvice(colony: ColonyView) {
  const extracted = new Set(colony.extractors.map((e) => e.productTypeId));
  const { stock, volume } = stockMaps(colony);
  const totalCapacity =
    colony.storage.reduce((sum, s) => sum + s.capacity, 0) || 1;

  const short = colony.balance
    .filter((b) => b.net < -EPS)
    .map((b) => {
      const onHand = stock.get(b.typeId) ?? 0;
      return { ...b, stock: onHand, runwayHours: onHand / -b.net };
    })
    .sort((a, b) => a.runwayHours - b.runwayHours);

  const over = colony.balance
    .filter((b) => {
      if (!extracted.has(b.typeId)) return false;
      const share = (volume.get(b.typeId) ?? 0) / totalCapacity;
      return b.net > EPS || share > BANK_VOLUME_SHARE;
    })
    .map((b) => ({ ...b, stock: stock.get(b.typeId) ?? 0 }))
    .sort((a, b) => b.stock - a.stock || b.net - a.net);

  return { short, over };
}

/** Fallback runway cutoff (hours) when the colony has no live extractor
 *  program to key urgency off — a deficit under this reads red. */
const FALLBACK_RED_HOURS = 6;
/** Fallback runway cutoff (hours) — under this reads amber. */
const FALLBACK_AMBER_HOURS = 24;

/** Runway urgency cutoffs (hours). Below `redHours` is about to stall; below
 *  `amberHours` wants feeding this cycle. */
export interface RunwayThresholds {
  redHours: number;
  amberHours: number;
}

const FALLBACK_THRESHOLDS: RunwayThresholds = {
  redHours: FALLBACK_RED_HOURS,
  amberHours: FALLBACK_AMBER_HOURS,
};

/** Derive runway urgency cutoffs from the colony's own rhythm: the
 *  soonest-expiring extractor program is your next forced visit, so a deficit
 *  that empties before then (red) stalls the chain before you're back anyway;
 *  within ~2× that window is amber. When no program is live (nothing with a
 *  future expiry), fall back to fixed hours. `now` is unix ms. Pure. */
export function runwayThresholds(
  colony: ColonyView,
  now: number,
): RunwayThresholds {
  let soonest = Infinity;
  for (const e of colony.extractors) {
    if (!e.expiryTime) continue;
    const ms = Date.parse(e.expiryTime);
    if (Number.isNaN(ms)) continue;
    const hours = (ms - now) / 3_600_000;
    if (hours > 0 && hours < soonest) soonest = hours;
  }
  if (!Number.isFinite(soonest)) return FALLBACK_THRESHOLDS;
  return { redHours: soonest, amberHours: soonest * 2 };
}

/** How long current stock lasts against the balance rate, as a triage label +
 *  colour tone (and a hover `title`). Runway is only a countdown for a deficit
 *  (net < 0): a surplus accumulates and a break-even holds, so those report
 *  status instead. Colour is by *urgency* — empty/soon is red, this-cycle is
 *  amber, well-buffered/steady/surplus is calm. Pure. */
export function runway(
  stock: number,
  net: number,
  thresholds: RunwayThresholds = FALLBACK_THRESHOLDS,
): { label: string; tone: string; title: string } {
  if (net > EPS)
    return {
      label: "▲ surplus",
      tone: "text-emerald-400",
      title: "Accumulating — extraction outpaces use; ease off next cycle.",
    };
  if (net >= -EPS)
    return {
      label: "steady",
      tone: "text-zinc-500",
      title: "Break-even — made and used at the same rate.",
    };
  if (stock <= EPS)
    return {
      label: "empty",
      tone: "text-rose-400",
      title: "No stock and running a deficit — the chain is stalled on this.",
    };
  const hours = stock / -net;
  const tone =
    hours < thresholds.redHours
      ? "text-rose-400"
      : hours < thresholds.amberHours
        ? "text-amber-300"
        : "text-zinc-400";
  return {
    label: formatRunway(hours),
    tone,
    title: `About ${formatRunway(hours)} of stock left at the current deficit.`,
  };
}

/** A runway in hours as a compact duration: minutes under 1h, whole hours
 *  under a day, else days (+ hours). Rounds to whole hours first so it never
 *  shows "24h" or "1d 24h". Pure. */
function formatRunway(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const rh = Math.round(hours);
  if (rh < 24) return `${rh}h`;
  const d = Math.floor(rh / 24);
  const h = rh % 24;
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
