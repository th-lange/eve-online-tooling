import { useEffect, useRef, useState } from "react";
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

  // Only resync the text fields on a *genuine external* value change — the
  // parent reseeding the form, or a quick offset below. We must NOT resync in
  // response to our own edits: while the user is mid-typing the value is
  // briefly NaN (an incomplete time), and `NaN !== NaN` would otherwise make
  // every keystroke look like an external change and wipe both fields.
  // `Object.is` treats NaN as equal to NaN, so a mid-edit NaN compares equal
  // to what we just emitted and is left alone.
  const lastEmitted = useRef(value);
  useEffect(() => {
    if (!Object.is(value, lastEmitted.current)) {
      lastEmitted.current = value;
      setDate(toDate(value));
      setTime(toTime(value));
    }
  }, [value]);

  const edit = (d: string, t: string) => {
    setDate(d);
    setTime(t);
    const next = combine(d, t);
    lastEmitted.current = next;
    onChange(next);
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
            // Add to the time currently entered (so they compound, and e.g.
            // "+1h" nudges a pre-filled extraction end), falling back to now
            // when the field is empty/invalid.
            onClick={() => onChange((valid ? ms : Date.now()) + o.ms)}
            title={`Add ${o.label.slice(1)} to the time above`}
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
