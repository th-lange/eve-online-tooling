// Reminders (#NNN): user-registered, one-shot reminders for recurring EVE
// chores — a Planetary Interaction extraction ending, a production or
// invention job completing, or anything else ("Other"). Deliberately
// *app-active only*: there's no OS-level background scheduler, so a reminder
// fires while the app is open and, if its time already passed while the app
// was closed, is surfaced once on the next launch (see `ReminderProvider`).

/** What the reminder is about — a known EVE chore type, or free-form. */
export type ReminderCategory = "pi" | "production" | "invention" | "other";

/** The category picker's options, in display order. */
export const REMINDER_CATEGORIES: readonly {
  key: ReminderCategory;
  label: string;
}[] = [
  { key: "pi", label: "Planetary Interaction" },
  { key: "production", label: "Production" },
  { key: "invention", label: "Invention" },
  { key: "other", label: "Other" },
];

/** Display label for a category (falls back to the raw key if unknown). */
export function categoryLabel(category: ReminderCategory): string {
  return REMINDER_CATEGORIES.find((c) => c.key === category)?.label ?? category;
}

/** One reminder. `dueAt` is epoch ms; `note` is "" when omitted. */
export interface Reminder {
  id: string;
  category: ReminderCategory;
  /** The "what" — a short title, e.g. "Pator colony extraction". */
  what: string;
  /** Optional free-text detail; "" when none. */
  note: string;
  /** The "when" — epoch milliseconds. */
  dueAt: number;
}

/** The editable fields of a reminder (everything but its generated id). */
export type ReminderDraft = Omit<Reminder, "id">;

/** Reminders whose time has arrived (`dueAt <= now`), earliest first. */
export function dueReminders(
  list: readonly Reminder[],
  now: number,
): Reminder[] {
  return list.filter((r) => r.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
}

/** All reminders sorted by due time, earliest first — the list-view order. */
export function sortByDue(list: readonly Reminder[]): Reminder[] {
  return [...list].sort((a, b) => a.dueAt - b.dueAt);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Snooze presets offered when a due reminder is surfaced. */
export const SNOOZE_OPTIONS: readonly { label: string; ms: number }[] = [
  { label: "10 min", ms: 10 * MINUTE },
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: DAY },
];

/** Human-readable relative time, e.g. "in 5m", "2h ago", "now". Coarse on
 *  purpose — reminders don't need second precision. */
export function formatWhen(dueAt: number, now: number): string {
  const delta = dueAt - now;
  const abs = Math.abs(delta);
  if (abs < MINUTE) return "now";
  const unit = abs >= DAY ? "d" : abs >= HOUR ? "h" : "m";
  const n =
    unit === "d"
      ? Math.round(abs / DAY)
      : unit === "h"
        ? Math.round(abs / HOUR)
        : Math.round(abs / MINUTE);
  return delta >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

/** Epoch ms → a `datetime-local` input value (`YYYY-MM-DDTHH:mm`, local tz). */
export function toDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** A `datetime-local` input value → epoch ms, or `NaN` if unparseable. */
export function fromDatetimeLocal(value: string): number {
  return new Date(value).getTime();
}
