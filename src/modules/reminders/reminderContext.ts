import { createContext, useContext } from "react";
import type { Reminder, ReminderDraft } from "./reminders";

/** Reminders state + mutators, owned by `ReminderProvider` (mounted at the
 *  app root) so the Settings card and the root-level due-watcher share one
 *  source of truth — `usePersistentState` has no cross-instance sync, so two
 *  separate copies would drift. Mirrors the recording/fight-overlay pattern. */
export interface ReminderCtx {
  reminders: Reminder[];
  /** Create a reminder (a fresh id is generated). */
  add: (draft: ReminderDraft) => void;
  /** Patch an existing reminder's editable fields. */
  update: (id: string, patch: Partial<ReminderDraft>) => void;
  /** Delete a reminder (also how a surfaced one is "done"/dismissed). */
  remove: (id: string) => void;
  /** Push a reminder's due time `ms` into the future from now. */
  snooze: (id: string, ms: number) => void;
}

export const ReminderContext = createContext<ReminderCtx>({
  reminders: [],
  add: () => {},
  update: () => {},
  remove: () => {},
  snooze: () => {},
});

export function useReminders(): ReminderCtx {
  return useContext(ReminderContext);
}
