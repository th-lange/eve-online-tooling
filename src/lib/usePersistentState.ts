import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  EXTERNAL_STORAGE_EVENT,
  type ExternalStorageEventDetail,
} from "./externalStorageEvent";

function readPersisted<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) return JSON.parse(raw) as T;
  } catch {
    // Malformed/inaccessible storage — fall back to the default.
  }
  return initial;
}

/**
 * Like `useState`, but the value **persists** to `localStorage` under `key`, so
 * it survives unmount/remount (e.g. switching tabs away and back) and app
 * restarts. JSON-serialized; a malformed/unavailable store falls back to
 * `initial` and the state still works in-memory.
 *
 * Also listens for `EXTERNAL_STORAGE_EVENT`s matching `key` (see
 * `externalStorageEvent.ts`) and re-reads from localStorage when one fires —
 * lets something that wrote `key` directly (bypassing this hook's own
 * setter, e.g. a folder-sync store's `apply()`) show up immediately in any
 * already-mounted hook instead of waiting for a remount.
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => readPersisted(key, initial));

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Storage may be unavailable; state still works in-memory.
    }
  }, [key, state]);

  useEffect(() => {
    function onExternal(e: Event) {
      const detail = (e as CustomEvent<ExternalStorageEventDetail>).detail;
      if (detail?.key !== key) return;
      setState(readPersisted(key, initial));
    }
    window.addEventListener(EXTERNAL_STORAGE_EVENT, onExternal);
    return () => window.removeEventListener(EXTERNAL_STORAGE_EVENT, onExternal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [state, setState];
}
