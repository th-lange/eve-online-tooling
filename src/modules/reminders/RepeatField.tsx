import { useEffect, useState } from "react";
import { REPEAT_UNITS, toRepeat } from "./reminders";

const unitMs = (key: string) =>
  REPEAT_UNITS.find((u) => u.key === key)?.ms ?? 24 * 60 * 60_000;

/**
 * "Repeat every N hours/days/weeks" control. Emits the interval in ms (or
 * `null` when repeating is off). Used by both reminder forms (Settings page +
 * PI colony). A repeating reminder is rescheduled to its next occurrence when
 * completed instead of being deleted (see `ReminderProvider`'s `complete`).
 */
export function RepeatField({
  value,
  onChange,
}: {
  value: number | null | undefined;
  onChange: (ms: number | null) => void;
}) {
  const seed = value && value > 0 ? toRepeat(value) : { n: 1, unit: "days" };
  const [on, setOn] = useState(value != null && value > 0);
  const [n, setN] = useState(seed.n);
  const [unit, setUnit] = useState(seed.unit);

  // Resync from an external value (e.g. loading a reminder into the form).
  useEffect(() => {
    if (value != null && value > 0) {
      const r = toRepeat(value);
      setOn(true);
      setN(r.n);
      setUnit(r.unit);
    } else {
      setOn(false);
    }
  }, [value]);

  const emit = (o: boolean, nn: number, u: string) =>
    onChange(o ? Math.max(1, nn) * unitMs(u) : null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const o = e.currentTarget.checked;
            setOn(o);
            emit(o, n, unit);
          }}
          className="h-4 w-4 cursor-pointer accent-indigo-500"
          aria-label="Repeat this reminder"
        />
        Repeat every
      </label>
      <input
        type="number"
        min={1}
        value={n}
        disabled={!on}
        onChange={(e) => {
          const nn = Math.max(1, Number(e.currentTarget.value) || 1);
          setN(nn);
          emit(on, nn, unit);
        }}
        aria-label="Repeat interval"
        className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
      />
      <select
        value={unit}
        disabled={!on}
        onChange={(e) => {
          const u = e.currentTarget.value;
          setUnit(u);
          emit(on, n, u);
        }}
        aria-label="Repeat unit"
        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-200 disabled:opacity-50"
      >
        {REPEAT_UNITS.map((u) => (
          <option key={u.key} value={u.key}>
            {u.label}
          </option>
        ))}
      </select>
    </div>
  );
}
