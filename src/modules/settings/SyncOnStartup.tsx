import { useEffect, useRef } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { syncNow } from "../../lib/sync/syncNow";

/**
 * Best-effort "sync on startup" (#1128): if a sync folder is configured and
 * the "Sync on startup" setting is on, runs `syncNow` once per launch.
 * Mounted once at the app root (`Layout`, alongside `NavBridge`) so it has
 * router/query context; never blocks launch and swallows failures (surfaced
 * only via `console.error`, same as the deferred SDE/character warm-up on
 * the Rust side) — the Settings page's "Sync now" is the authoritative, user
 * -visible way to sync. Renders nothing.
 */
export function SyncOnStartup() {
  const [folder] = usePersistentState<string>(STORAGE_KEYS.syncFolder, "");
  const [onStartup] = usePersistentState<boolean>(
    STORAGE_KEYS.syncOnStartup,
    false,
  );
  const [enabled] = usePersistentState<boolean>(
    STORAGE_KEYS.syncEnabled,
    false,
  );
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const dir = folder.trim();
    if (!enabled || !onStartup || !dir) return;
    void syncNow(dir).catch((e: unknown) => {
      console.error("Sync on startup failed", e);
    });
    // Intentionally runs at most once per mount (the `ran` guard), reading
    // whatever folder/onStartup settled to on first render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
