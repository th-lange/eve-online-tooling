import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Modal } from "../../components/Modal";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { REMINDER_CHECK_INTERVAL_MS } from "../../lib/refreshIntervals";
import { ReminderContext, type ReminderCtx } from "./reminderContext";
import {
  categoryLabel,
  dueReminders,
  formatWhen,
  SNOOZE_OPTIONS,
  type Reminder,
  type ReminderDraft,
} from "./reminders";

/** Best-effort desktop notification — same permission-gated idiom as the FW
 *  home-defense / local-intel alerts. Silent on any failure (not running under
 *  Tauri, permission denied): the in-app modal is the primary surface. */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable — the in-app modal still shows */
  }
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `r-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Root-level reminders watcher (#NNN). Owns the persisted reminder list (so
 * the Settings card and this watcher never disagree) and, **only while the app
 * is running**, surfaces reminders as their time arrives:
 *
 * - On mount it checks immediately, so anything that came due while the app
 *   was closed is caught on the next launch ("nothing passed" guarantee).
 * - Then on a {@link REMINDER_CHECK_INTERVAL_MS} tick for the rest of the
 *   session.
 *
 * A newly-due reminder fires one desktop notification and is added to the
 * in-app "due" modal. Each due reminder is only *announced* once per session
 * (`surfacedRef`) so dismissing the modal doesn't make it pop straight back —
 * it reappears only if a *different* reminder comes due. The reminder itself
 * stays in the list (visible in Settings) until the user snoozes or deletes it.
 */
export function ReminderProvider({ children }: { children: ReactNode }) {
  const [reminders, setReminders] = usePersistentState<Reminder[]>(
    STORAGE_KEYS.reminders,
    [],
  );

  const add = useCallback(
    (draft: ReminderDraft) =>
      setReminders((prev) => [...prev, { ...draft, id: newId() }]),
    [setReminders],
  );
  const update = useCallback(
    (id: string, patch: Partial<ReminderDraft>) =>
      setReminders((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      ),
    [setReminders],
  );
  const remove = useCallback(
    (id: string) => setReminders((prev) => prev.filter((r) => r.id !== id)),
    [setReminders],
  );
  const snooze = useCallback(
    (id: string, ms: number) =>
      setReminders((prev) =>
        prev.map((r) => (r.id === id ? { ...r, dueAt: Date.now() + ms } : r)),
      ),
    [setReminders],
  );

  const ctx: ReminderCtx = { reminders, add, update, remove, snooze };

  // --- Firing ---
  const [now, setNow] = useState(() => Date.now());
  const [modalOpen, setModalOpen] = useState(false);
  // Reminders already announced this session (modal + notification), so a
  // dismissed modal doesn't immediately re-open for the same ones.
  const announcedRef = useRef<Set<string>>(new Set());
  // Latest reminders, read inside the interval without re-arming it.
  const remindersRef = useRef(reminders);
  remindersRef.current = reminders;

  useEffect(() => {
    const check = () => {
      const t = Date.now();
      setNow(t);
      const due = dueReminders(remindersRef.current, t);
      const fresh = due.filter((r) => !announcedRef.current.has(r.id));
      if (fresh.length === 0) return;
      for (const r of fresh) {
        announcedRef.current.add(r.id);
        void notify(`Reminder: ${r.what}`, r.note || categoryLabel(r.category));
      }
      setModalOpen(true);
    };
    check(); // startup: catch anything that came due while closed
    const id = setInterval(check, REMINDER_CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Drop announced ids once their reminder is gone/rescheduled into the
  // future, so a snoozed reminder can announce again when it next comes due.
  useEffect(() => {
    const live = new Set(
      reminders.filter((r) => r.dueAt <= now).map((r) => r.id),
    );
    for (const id of announcedRef.current) {
      if (!live.has(id)) announcedRef.current.delete(id);
    }
  }, [reminders, now]);

  const due = dueReminders(reminders, now);
  const showModal = modalOpen && due.length > 0;

  return (
    <ReminderContext.Provider value={ctx}>
      {children}
      <Modal
        open={showModal}
        onClose={() => setModalOpen(false)}
        role="alertdialog"
        aria-label="Reminders due"
        backdropClassName="fixed inset-0 z-40 bg-black/40"
        className="fixed left-1/2 top-1/2 z-50 max-h-[80vh] w-96 -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl"
      >
        <h2 className="text-sm font-semibold text-zinc-100">
          {due.length === 1 ? "Reminder due" : `${due.length} reminders due`}
        </h2>
        <ul className="mt-3 flex flex-col gap-3">
          {due.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-zinc-100">
                  {r.what}
                </span>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
                  {categoryLabel(r.category)}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-amber-400">
                Due {formatWhen(r.dueAt, now)}
              </div>
              {r.note && (
                <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">
                  {r.note}
                </p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {SNOOZE_OPTIONS.map((o) => (
                  <button
                    key={o.ms}
                    type="button"
                    onClick={() => snooze(r.id, o.ms)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Snooze {o.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  className="ml-auto rounded bg-emerald-700 px-2.5 py-0.5 text-xs text-white hover:bg-emerald-600"
                >
                  Done
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => setModalOpen(false)}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            Later
          </button>
        </div>
      </Modal>
    </ReminderContext.Provider>
  );
}
