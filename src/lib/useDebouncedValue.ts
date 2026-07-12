import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delayMs`, collapsing rapid changes into a single
 * update once input settles. Used to keep search-as-you-type from re-filtering
 * large lists (and re-cloning the asset tree) on every keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs = 150): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
