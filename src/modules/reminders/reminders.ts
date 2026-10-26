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
  /** Repeat interval in ms; `null`/absent = one-shot. On completion a
   *  repeating reminder is rescheduled by this amount instead of deleted. */
  repeatMs?: number | null;
  /** Optional deep link: the module to open (and an optional PI colony to
   *  focus) when the reminder's type badge is clicked. Absent → the badge
   *  routes to the category's default module. */
  link?: ReminderLink | null;
}

/** Where a reminder's type badge navigates. */
export interface ReminderLink {
  /** Module id (registry) to open, e.g. "pi". */
  moduleId: string;
  /** When set, the PI colony (planet id) to scroll to + highlight. */
  planetId?: number;
}

/** Category → default module for a reminder with no explicit {@link link}:
 *  PI → the PI module, production → Production, invention → Industry Jobs
 *  (where invention jobs show). "other" has no sensible target. */
const CATEGORY_MODULE: Record<ReminderCategory, string | null> = {
  pi: "pi",
  production: "production",
  invention: "industry-jobs",
  other: null,
};

/** The navigation target for a reminder's type badge, or `null` when there's
 *  nowhere sensible to go (an "Other" reminder with no explicit link). */
export function reminderTarget(r: Reminder): ReminderLink | null {
  if (r.link) return r.link;
  const moduleId = CATEGORY_MODULE[r.category];
  return moduleId ? { moduleId } : null;
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
  { label: "10m", ms: 10 * MINUTE },
  { label: "1h", ms: HOUR },
  { label: "1d", ms: DAY },
];

const WEEK = 7 * DAY;

/** Units for a custom "remind me again in N …" snooze. */
export const SNOOZE_UNITS: readonly {
  key: string;
  label: string;
  ms: number;
}[] = [
  { key: "minutes", label: "minutes", ms: MINUTE },
  { key: "hours", label: "hours", ms: HOUR },
  { key: "days", label: "days", ms: DAY },
];

/** Units for a repeat interval, largest last — the repeat picker's options. */
export const REPEAT_UNITS: readonly {
  key: string;
  label: string;
  ms: number;
}[] = [
  { key: "hours", label: "hours", ms: HOUR },
  { key: "days", label: "days", ms: DAY },
  { key: "weeks", label: "weeks", ms: WEEK },
];

/** An interval in ms → a `{ n, unit }` pair using the largest unit that
 *  divides it exactly (so 6 days reads as "6 days", not "144 hours"). */
export function toRepeat(ms: number): { n: number; unit: string } {
  for (const u of [...REPEAT_UNITS].reverse()) {
    if (ms % u.ms === 0) return { n: ms / u.ms, unit: u.key };
  }
  return { n: Math.max(1, Math.round(ms / HOUR)), unit: "hours" };
}

/** Compact repeat label, e.g. "every 6d" / "every 2w". */
export function formatRepeat(ms: number): string {
  const { n, unit } = toRepeat(ms);
  const short = unit === "weeks" ? "w" : unit === "days" ? "d" : "h";
  return `every ${n}${short}`;
}

/** The next occurrence of a repeating reminder strictly after `now`: advance
 *  `dueAt` by whole `repeatMs` periods, skipping any that elapsed while the
 *  app was closed, so completing it never lands back in the past. */
export function advance(dueAt: number, repeatMs: number, now: number): number {
  if (repeatMs <= 0) return dueAt;
  const periods = Math.max(1, Math.ceil((now - dueAt) / repeatMs));
  let next = dueAt + periods * repeatMs;
  if (next <= now) next += repeatMs;
  return next;
}

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
