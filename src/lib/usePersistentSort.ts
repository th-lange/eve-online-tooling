import { useEffect, useState } from "react";

export type SortDir = "asc" | "desc";

/**
 * Table sort state (column key + direction) that **persists** to `localStorage`
 * so it survives recalcs, tab switches, and app restarts (#21). Each table
 * passes a unique `storageKey`; the saved column is validated against
 * `validKeys` so a stale/removed column falls back to the default.
 *
 * `textKeys` lists columns that should default to **ascending** when first
 * selected (e.g. names); everything else defaults to descending.
 */
export function usePersistentSort<K extends string>(
  storageKey: string,
  validKeys: readonly K[],
  defaultKey: K,
  defaultDir: SortDir,
  textKeys: readonly K[] = [],
) {
  const [state, setState] = useState<{ key: K; dir: SortDir }>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { key?: K; dir?: SortDir };
        if (
          saved.key &&
          validKeys.includes(saved.key) &&
          (saved.dir === "asc" || saved.dir === "desc")
        ) {
          return { key: saved.key, dir: saved.dir };
        }
      }
    } catch {
      // Malformed/inaccessible storage — fall back to the default.
    }
    return { key: defaultKey, dir: defaultDir };
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Storage may be unavailable; sorting still works in-memory.
    }
  }, [storageKey, state]);

  // Click a column: flip direction if it's already the sort key, else switch to
  // it with a sensible default direction.
  function toggleSort(key: K) {
    setState((s) =>
      key === s.key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: textKeys.includes(key) ? "asc" : "desc" },
    );
  }

  return { sortKey: state.key, sortDir: state.dir, toggleSort };
}
