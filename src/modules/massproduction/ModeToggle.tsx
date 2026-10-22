import { type PlanMode } from "../../lib/api";

/** Owned-copies vs. Hypothetical mode toggle (#893) — Owned matches every
 * pasted blueprint against real ESI-owned copies (#883's original
 * behavior); Hypothetical assumes a rule-derived (runs, ME) per line
 * instead, with zero ESI ownership calls. */
export function ModeToggle({
  mode,
  onChange,
}: {
  mode: PlanMode;
  onChange: (m: PlanMode) => void;
}) {
  const options: { value: PlanMode; label: string }[] = [
    { value: "owned", label: "Owned copies" },
    { value: "hypothetical", label: "Hypothetical" },
  ];
  return (
    <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={mode === o.value}
          className={`px-3 py-1.5 font-medium transition-colors ${
            mode === o.value
              ? "bg-indigo-600 text-white"
              : "bg-transparent text-zinc-400 hover:bg-zinc-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
