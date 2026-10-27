// A `window` event so `usePersistentState` hooks can be told "your key
// changed in localStorage from outside React" (e.g. the folder-sync
// reminders store's `apply()` writing straight to localStorage) and re-read
// it immediately, instead of the stale value sitting until next remount.

export const EXTERNAL_STORAGE_EVENT = "persisted-state:external";

export interface ExternalStorageEventDetail {
  key: string;
}

/** Tell any mounted `usePersistentState(key, ...)` to re-read `key` from
 *  localStorage right now. Call this after writing `key` directly (bypassing
 *  the hook's own setter). */
export function notifyExternalStorageChange(key: string): void {
  window.dispatchEvent(
    new CustomEvent<ExternalStorageEventDetail>(EXTERNAL_STORAGE_EVENT, {
      detail: { key },
    }),
  );
}
