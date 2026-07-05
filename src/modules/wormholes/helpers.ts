// Small shared helpers for the Wormholes module — a non-component file so
// react-refresh hot-reloads the panel components cleanly.

/** Wormhole mass states, in freshness order. */
export const MASS = ["fresh", "reduced", "critical"];

/** Format a mass in kg as millions-of-kg (the scale WH physics live at). */
export function fmtMkg(kg: number): string {
  return `${(kg / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} Mkg`;
}

/** Hours label from minutes. */
export function fmtHours(min: number | null): string {
  return min == null ? "—" : `${(min / 60).toFixed(0)}h`;
}

export function massColor(m: string): string {
  if (m === "critical") return "text-rose-400";
  if (m === "reduced") return "text-amber-400";
  return "text-emerald-400";
}
