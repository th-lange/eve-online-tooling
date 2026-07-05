// Small pure helpers for the Production module, kept out of the component
// files so react-refresh can hot-reload those cleanly.

import type { ProfitBreakdown } from "../../lib/api";

/** Distinct, sorted values of `pick` across the rows (nulls skipped). */
export function uniqueSorted(
  rows: ProfitBreakdown[],
  pick: (r: ProfitBreakdown) => string | null,
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (v) set.add(v);
  }
  return [...set].sort();
}

/** Immutable toggle of `v` in a set (returns a new Set). */
export function toggle(set: Set<string>, v: string): Set<string> {
  const next = new Set(set);
  next.has(v) ? next.delete(v) : next.add(v);
  return next;
}
