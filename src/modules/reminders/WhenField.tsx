import { useEffect, useState } from "react";
import { formatWhen, fromDatetimeLocal, toDatetimeLocal } from "./reminders";

/** Quick "remind me later" offsets, relative to now. */
const OFFSETS: readonly { label: string; ms: number }[] = [
  { label: "+1h", ms: 60 * 60_000 },
  { label: "+6h", ms: 6 * 60 * 60_000 },
  { label: "+1d", ms: 24 * 60 * 60_000 },
];

/** Epoch ms → the date half (`YYYY-MM-DD`) of a local wall-clock time. */
function toDate(ms: number): string {
  return Number.isNaN(ms) ? "" : toDatetimeLocal(ms).slice(0, 10);
}
/** Epoch ms → the time half (`HH:MM`) of a local wall-clock time. */
function toTime(ms: number): string {
  return Number.isNaN(ms) ? "" : toDatetimeLocal(ms).slice(11);
}
/** A `YYYY-MM-DD` + `HH:MM` pair → epoch ms, or `NaN` if either is blank or
 *  unparseable. */
function combine(date: string, time: string): number {
  if (!date || !time) return NaN;
  return fromDatetimeLocal(`${date}T${time}`);
}

/**
 * A date + time picker that works in every webview. The native
 * `datetime-local` control is effectively unusable under WebKitGTK (Linux), so
 * this uses plain text inputs (`YYYY-MM-DD` / `HH:MM`) plus quick relative
 * offsets, with a live preview of the resolved time. Controlled on epoch ms;
 * `onChange` receives `NaN` while the entry is incomplete/invalid so the caller
 * can block submit.
 */
export function WhenField({
  value,
  onChange,
}: {
  value: number;
  onChange: (ms: number) => void;
}) {
  const [date, setDate] = useState(() => toDate(value));
  const [time, setTime] = useState(() => toTime(value));

  // Resync the text fields when the value is changed from outside (a quick
  // offset below, or the parent reseeding the form) — but not while the user
  // is mid-edit, since then `combine(date, time)` already equals `value`.
  useEffect(() => {
    if (combine(date, time) !== value) {
      setDate(toDate(value));
      setTime(toTime(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const edit = (d: string, t: string) => {
    setDate(d);
    setTime(t);
    onChange(combine(d, t));
  };

  const ms = combine(date, time);
  const valid = !Number.isNaN(ms);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={date}
          onChange={(e) => edit(e.currentTarget.value, time)}
          placeholder="YYYY-MM-DD"
          aria-label="Reminder date (YYYY-MM-DD)"
          className="w-32 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        <input
          type="text"
          inputMode="numeric"
          value={time}
          onChange={(e) => edit(date, e.currentTarget.value)}
          placeholder="HH:MM"
          aria-label="Reminder time (HH:MM)"
          className="w-20 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-sm text-zinc-200 placeholder:text-zinc-600"
        />
        {OFFSETS.map((o) => (
          <button
            key={o.label}
            type="button"
            onClick={() => onChange(Date.now() + o.ms)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className={`text-xs ${valid ? "text-zinc-500" : "text-rose-400"}`}>
        {valid
          ? `Due ${new Date(ms).toLocaleString()} · ${formatWhen(ms, Date.now())}`
          : "Enter a date as YYYY-MM-DD and a time as HH:MM."}
      </span>
    </div>
  );
}
