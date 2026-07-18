import { type ReactNode } from "react";

/**
 * Shared form atoms (#616). These were copy-pasted into 8+ module pages;
 * every page-level filter/settings panel should compose these instead so a
 * styling tweak is one edit, not eight.
 */

/** Labelled form field wrapper: small zinc label above arbitrary content. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

/** Labelled numeric input (non-negative, 0.1 steps) — fees, thresholds, … */
export function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={0}
        step={0.1}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

/**
 * Wrapping pill-checkbox multi-select over a string option list. The copies
 * this replaces had drifted only in their scroll cap, so that is a prop:
 * pass a Tailwind `max-h-*` class to override the default.
 */
export function CheckboxGroup({
  options,
  selected,
  onToggle,
  maxHeight = "max-h-28",
}: {
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  /** Tailwind max-height class capping the scroll area. */
  maxHeight?: string;
}) {
  if (options.length === 0) {
    return <div className="text-xs text-zinc-600">—</div>;
  }
  return (
    <div className={`flex ${maxHeight} flex-wrap gap-1 overflow-auto`}>
      {options.map((o) => (
        <label
          key={o}
          className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs ${
            selected.has(o)
              ? "bg-zinc-700 text-zinc-100"
              : "bg-zinc-800 text-zinc-400"
          }`}
        >
          <input
            type="checkbox"
            checked={selected.has(o)}
            onChange={() => onToggle(o)}
          />
          {o}
        </label>
      ))}
    </div>
  );
}

/** Search input + "N of M shown" count for filtering a results table. */
export function SearchFilterRow({
  value,
  onChange,
  placeholder,
  shown,
  total,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  shown: number;
  total: number;
}) {
  return (
    <div className="mb-2 flex items-center gap-3">
      <input
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      <span className="text-xs text-zinc-500">
        {shown} of {total} shown
      </span>
    </div>
  );
}
