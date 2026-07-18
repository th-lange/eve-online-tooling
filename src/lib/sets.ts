// Small pure Set helpers shared by the module filter panels (#616).

/** Distinct, sorted values of `pick` across the rows (nulls skipped). */
export function uniqueSorted<T>(
  rows: readonly T[],
  pick: (r: T) => string | null,
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (v) set.add(v);
  }
  return [...set].sort();
}

/** Immutable toggle of `v` in a set (returns a new Set). */
export function toggle<T>(set: Set<T>, v: T): Set<T> {
  const next = new Set(set);
  if (next.has(v)) {
    next.delete(v);
  } else {
    next.add(v);
  }
  return next;
}
