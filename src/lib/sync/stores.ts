// The registry of synced modules (#1128) — deliberately just two for now:
// reminders (frontend-only localStorage) and PI planner setups (the raw,
// unresolved backend store). Never sync SDE, ESI/market/webkit caches, or
// SSO/keychain tokens.

import { STORAGE_KEYS } from "../storageKeys";
import { piPlannerSetupsExport, piPlannerSetupsImport } from "../api/pi";
import { queryClient } from "../queryClient";
import { piKeys } from "../queryKeys";
import { notifyExternalStorageChange } from "../externalStorageEvent";
import type { Reminder } from "../../modules/reminders/reminders";

/** One module a folder sync can carry. `schema` is a bump-on-incompatible-
 *  change version tag written into the sync file and checked on read — a
 *  file written with a different schema than this store expects is ignored
 *  (never applied, never silently reinterpreted). */
export interface SyncableStore {
  module: string;
  schema: number;
  label: string;
  read(): Promise<unknown>;
  apply(data: unknown): Promise<void>;
}

// Character scoping: every store here is **global** — its data carries no EVE
// character id (reminders and PI planner setups reference only universal
// type/system/planet ids), so one sync file per module is correct and sharing
// across devices with different logged-in characters is safe. If a future
// per-character store is added, DON'T put it in one shared file: namespace its
// sync `module`/file by the active character id (e.g. `watchlist-<charId>`) and
// key its manifest entry the same way, so one character's data never clobbers
// another's across devices.

const remindersStore: SyncableStore = {
  module: "reminders",
  schema: 1,
  label: "Reminders",
  async read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.reminders);
      return raw != null ? (JSON.parse(raw) as Reminder[]) : [];
    } catch {
      return [];
    }
  },
  async apply(data) {
    localStorage.setItem(STORAGE_KEYS.reminders, JSON.stringify(data));
    // ReminderProvider's `usePersistentState` only reads localStorage on
    // mount — tell any already-mounted instance to re-read now.
    notifyExternalStorageChange(STORAGE_KEYS.reminders);
  },
};

const piStore: SyncableStore = {
  module: "pi",
  schema: 1,
  label: "PI planner setups",
  async read() {
    return JSON.parse(await piPlannerSetupsExport()) as unknown;
  },
  async apply(data) {
    await piPlannerSetupsImport(JSON.stringify(data));
    void queryClient.invalidateQueries({ queryKey: piKeys.setups });
  },
};

/** Every module a folder sync walks, in order. */
export const SYNC_STORES: SyncableStore[] = [remindersStore, piStore];
