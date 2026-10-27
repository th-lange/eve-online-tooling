// The local sync manifest: `{ [module]: updatedAt }` in localStorage
// (`sync.meta`) — the last known local timestamp for each synced module,
// compared against a sync file's `updatedAt` to decide import vs. export.
// See `syncNow.ts` for the algorithm this feeds.

import { STORAGE_KEYS } from "../storageKeys";

export type SyncMeta = Record<string, number>;

function readMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.syncMeta);
    if (raw != null) return JSON.parse(raw) as SyncMeta;
  } catch {
    // Malformed/inaccessible storage — treat as "nothing synced yet".
  }
  return {};
}

function writeMeta(meta: SyncMeta): void {
  try {
    localStorage.setItem(STORAGE_KEYS.syncMeta, JSON.stringify(meta));
  } catch {
    // Storage unavailable — sync still works for this session, just won't
    // remember the manifest across a restart.
  }
}

/** The local `updatedAt` for `module`, or `0` if it's never been touched or
 *  imported. */
export function getMeta(module: string): number {
  return readMeta()[module] ?? 0;
}

/** Set the local `updatedAt` for `module` directly — used after an import to
 *  adopt the remote file's timestamp. */
export function setMeta(module: string, updatedAt: number): void {
  const meta = readMeta();
  meta[module] = updatedAt;
  writeMeta(meta);
}

/** Mark `module` as locally changed *now* — call this everywhere a synced
 *  module's data changes (reminders add/update/remove/snooze/complete, PI
 *  setup save/delete), so the next sync knows this device has the newer
 *  copy. */
export function touch(module: string): void {
  setMeta(module, Date.now());
}
