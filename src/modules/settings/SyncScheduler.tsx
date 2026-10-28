import { useCallback, useEffect, useRef } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { syncNow } from "../../lib/sync/syncNow";
import { subscribeSyncChange } from "../../lib/sync/manifest";
import {
  SYNC_CHANGE_DEBOUNCE_MS,
  SYNC_POLL_INTERVAL_MS,
} from "../../lib/refreshIntervals";

/**
 * Background auto-sync (#1128 follow-up). While sync is **Active** (a folder is
 * set and enabled in Settings), this runs `syncNow` automatically:
 *
 * - once on launch / whenever the folder changes (catch up),
 * - a few seconds after any local change (debounced — pushes your edits),
 * - every {@link SYNC_POLL_INTERVAL_MS} (pulls in other devices' changes).
 *
 * Runs are serialized (never overlapping; a change during a run re-runs once
 * after). Best-effort and silent on failure — the Settings "Sync now" button
 * stays the authoritative, user-visible path. Mounted once at the app root
 * (`Layout`). Renders nothing.
 */
export function SyncScheduler() {
  const [folder] = usePersistentState<string>(STORAGE_KEYS.syncFolder, "");
  const [enabled] = usePersistentState<boolean>(
    STORAGE_KEYS.syncEnabled,
    false,
  );
  const dir = folder.trim();
  const active = enabled && dir !== "";

  // Serialize: if a sync is already in flight, remember to run once more after
  // it settles rather than overlapping (a periodic tick + a change can coincide).
  const running = useRef(false);
  const rerun = useRef(false);
  const runSync = useCallback(() => {
    if (!active) return;
    if (running.current) {
      rerun.current = true;
      return;
    }
    running.current = true;
    void syncNow(dir)
      .catch((e: unknown) => console.error("Auto-sync failed", e))
      .finally(() => {
        running.current = false;
        if (rerun.current) {
          rerun.current = false;
          runSync();
        }
      });
  }, [active, dir]);

  // Startup + periodic pull.
  useEffect(() => {
    if (!active) return;
    runSync();
    const id = setInterval(runSync, SYNC_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, runSync]);

  // Debounced push on local change.
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = subscribeSyncChange(() => {
      clearTimeout(timer);
      timer = setTimeout(runSync, SYNC_CHANGE_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [active, runSync]);

  return null;
}
