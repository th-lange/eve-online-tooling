// Fit-context math + small shared helpers for the Fitting module — a
// non-component file so react-refresh hot-reloads the panels cleanly.

import type { ModuleInfo, SlotKind } from "../../lib/api";

/** Short slot labels for badges/tags. */
export const SLOT_BADGE: Partial<Record<SlotKind, string>> = {
  high: "High",
  mid: "Mid",
  low: "Low",
  rig: "Rig",
  subsystem: "Sub",
  implant: "Implant",
  drone: "Drone",
  cargo: "Cargo",
};

/** What the hull has free right now, for deciding whether a candidate fits. */
export interface FitContext {
  /** Open slots per kind (kinds without a hard cap — drone/cargo/… — are absent). */
  freeSlots: Partial<Record<SlotKind, number>>;
  /** Remaining CPU / powergrid / rig-calibration. */
  cpu: number;
  pg: number;
  calibration: number;
}

export const FIT_EPS = 1e-6;

/** Does this module fit the hull's free slots + remaining resources? Unknown
 *  info or no context ⇒ treated as fitting (don't gray things out prematurely). */
export function moduleFits(
  info: ModuleInfo | undefined,
  ctx: FitContext | null,
): boolean {
  return fitReason(info, ctx) === null;
}

/** Why a module won't fit (`"no slot"` / `"CPU"` / `"PG"` / `"calibration"`), or
 *  null when it fits. */
export function fitReason(
  info: ModuleInfo | undefined,
  ctx: FitContext | null,
): string | null {
  if (!info || !ctx) return null;
  const free = ctx.freeSlots[info.slot];
  if (free !== undefined && free <= 0) return "no slot";
  if (info.cpu > ctx.cpu + FIT_EPS) return "CPU";
  if (info.powergrid > ctx.pg + FIT_EPS) return "PG";
  if (info.slot === "rig" && info.calibration > ctx.calibration + FIT_EPS)
    return "calibration";
  return null;
}

/** Lower = better fuzzy match of `name` against the (already term-filtered)
 *  query: prefix beats substring beats scattered terms; ties broken by length. */
export function fuzzyScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  if (n.startsWith(query)) return 0;
  const idx = n.indexOf(query);
  if (idx >= 0) return 1 + idx / 1000;
  let s = 3;
  for (const t of query.split(/\s+/)) {
    const i = n.indexOf(t);
    s += i >= 0 ? i / 1000 : 5;
  }
  return s;
}

/** Metres → a compact "X.X km" label. */
export function km(metres: number): string {
  const v = metres / 1000;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} km`;
}

export const DAMAGE_TYPES = ["EM", "Th", "Kin", "Exp"] as const;

/** A resist % cell, tinted greener the higher the resistance (spot tank holes). */
export function resistClass(v: number): string {
  if (v >= 0.5) return "text-emerald-400";
  if (v >= 0.3) return "text-emerald-500/80";
  if (v > 0) return "text-zinc-300";
  return "text-zinc-600";
}
