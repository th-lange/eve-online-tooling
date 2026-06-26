import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * Like `useState`, but the value **persists** to `localStorage` under `key`, so
 * it survives unmount/remount (e.g. switching tabs away and back) and app
 * restarts. JSON-serialized; a malformed/unavailable store falls back to
 * `initial` and the state still works in-memory.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) return JSON.parse(raw) as T;
    } catch {
      // Malformed/inaccessible storage — fall back to the default.
    }
    return initial;
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Storage may be unavailable; state still works in-memory.
    }
  }, [key, state]);

  return [state, setState];
}
