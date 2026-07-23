import { useState } from "react";
import { BarChart2, Plus, X } from "lucide-react";
import {
  fittingSimulate,
  type Fit,
  type FitStats,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { km } from "./fitHelpers";
import { useFitLibrary } from "./useFitLibrary";

const MAX_SLOTS = 3;

type Slot = Fit | null;
type Result = FitStats | "error" | null;

/**
 * Side-by-side comparison of 2–3 fits: pick fits from the shared library
 * (same source as the Workbench's picker), simulate them together, and
 * diff key stats against the first column.
 */
export function ComparisonPanel({
  currentFit,
  nameOf,
  onClose,
}: {
  currentFit: Fit | null;
  nameOf: (id: number) => string;
  onClose: () => void;
}) {
  const library = useFitLibrary();
  const [slots, setSlots] = useState<Slot[]>([currentFit, null]);
  const [results, setResults] = useState<Result[]>([null, null]);
  const [pending, setPending] = useState(false);

  const setSlot = (i: number, fit: Slot) => {
    setSlots((prev) => prev.map((s, j) => (j === i ? fit : s)));
    setResults((prev) => prev.map((r, j) => (j === i ? null : r)));
  };

  const addSlot = () => {
    if (slots.length >= MAX_SLOTS) return;
    setSlots((prev) => [...prev, null]);
    setResults((prev) => [...prev, null]);
  };

  const removeSlot = (i: number) => {
    setSlots((prev) => prev.filter((_, j) => j !== i));
    setResults((prev) => prev.filter((_, j) => j !== i));
  };

  const simulateAll = async () => {
    setPending(true);
    try {
      const next = await Promise.all(
        slots.map((fit): Promise<Result> => {
          if (!fit) return Promise.resolve(null);
          return fittingSimulate(fit).catch(
            (): Result => "error" as const,
          );
        }),
      );
      setResults(next);
    } finally {
      setPending(false);
    }
  };

  const canSimulate = slots.some((s) => s != null);
  const baseline = results[0];

  return (
    <section className="rounded border border-zinc-700 bg-zinc-900/60 p-3">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500">
          <BarChart2 className="h-3.5 w-3.5" />
          Compare fits
        </h3>
        <button
          onClick={onClose}
          title="Close"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {slots.map((slot, i) => (
          <div key={i} className="flex items-end gap-1">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Fit {i + 1}
              <select
                value={
                  slot
                    ? (library.fitGroups
                        .flatMap((g) => g.fits)
                        .find((f) => f.fit === slot)?.key ?? "")
                    : ""
                }
                onChange={(e) => {
                  const f = library.fitByKey.get(e.currentTarget.value);
                  setSlot(i, f ?? null);
                }}
                className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">pick a fit…</option>
                {library.fitGroups.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.fits.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.hull} — {f.name}
                        {f.source === "in-game" ? "  (EVE)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {i > 0 && (
              <button
                onClick={() => removeSlot(i)}
                title="Remove this fit"
                className="mb-0.5 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}

        {slots.length < MAX_SLOTS && (
          <button
            onClick={addSlot}
            className="mb-0.5 flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" />
            Add a fit
          </button>
        )}

        <button
          onClick={() => void simulateAll()}
          disabled={!canSimulate || pending}
          className="mb-0.5 rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {pending ? "Simulating…" : "Simulate all"}
        </button>
      </div>

      {results.some((r) => r != null) && (
        <div className="mt-3 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-700 text-left text-xs uppercase tracking-wide text-zinc-500">
                <th className="py-1 pr-3 font-normal">Stat</th>
                {slots.map((fit, i) => (
                  <th key={i} className="py-1 pr-3 font-normal text-zinc-300">
                    {fit ? nameOf(fit.shipTypeId) : "—"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <StatRow label="Fit name" slots={slots} results={results}>
                {(fit) => fit?.name ?? "—"}
              </StatRow>
              <StatRow
                label="Paper DPS"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) => (r && typeof r === "object" ? (r.dps?.total ?? null) : null)}
                format={(v) => formatInt(v)}
              />
              <StatRow
                label="EHP"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) => (r && typeof r === "object" ? (r.tank?.ehp ?? null) : null)}
                format={(v) => formatInt(v)}
              />
              <StatRow
                label="Cap"
                slots={slots}
                results={results}
                render={(r) => {
                  if (r === "error")
                    return <span className="text-rose-400">error</span>;
                  if (!r) return <span className="text-zinc-600">—</span>;
                  const cap = r.capacitor;
                  if (!cap) return <span className="text-zinc-600">—</span>;
                  return cap.stable ? (
                    <span className="text-emerald-400">
                      {cap.stablePct != null
                        ? `${cap.stablePct.toFixed(0)}%`
                        : "stable"}
                    </span>
                  ) : (
                    <span className="text-rose-400">unstable</span>
                  );
                }}
              />
              <StatRow
                label="Max speed"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) =>
                  r && typeof r === "object"
                    ? (r.navigation?.maxVelocity ?? null)
                    : null
                }
                format={(v) => `${formatInt(v)} m/s`}
              />
              <StatRow
                label="Targeting range"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) =>
                  r && typeof r === "object" ? (r.targeting?.lockRange ?? null) : null
                }
                format={(v) => km(v)}
              />
            </tbody>
          </table>
        </div>
      )}

      {pending && (
        <div className="mt-3 flex gap-3">
          {slots
            .filter((s) => s != null)
            .map((_, i) => (
              <div
                key={i}
                className="h-16 w-40 animate-pulse rounded bg-zinc-800"
              />
            ))}
        </div>
      )}
    </section>
  );
}

/** Delta vs the baseline (first column), coloured green/red. */
function DeltaBadge({
  value,
  base,
  format,
}: {
  value: number;
  base: number;
  format: (v: number) => string;
}) {
  const diff = value - base;
  if (base === 0 || Number.isNaN(diff) || Math.abs(diff) < 1e-9) {
    return <span className="text-zinc-600">±0</span>;
  }
  const pct = (diff / base) * 100;
  const cls = diff > 0 ? "text-emerald-400" : "text-rose-400";
  const sign = diff > 0 ? "+" : "";
  return (
    <span className={`ml-2 text-xs ${cls}`}>
      ({sign}
      {format(diff)}, {sign}
      {pct.toFixed(1)}%)
    </span>
  );
}

/** One comparison row: either a custom `render`er per cell, or a numeric
 *  `stat` extractor + `format`ter that also drives the delta badge. */
function StatRow({
  label,
  slots,
  results,
  baseline,
  stat,
  format,
  render,
  children,
}: {
  label: string;
  slots: Slot[];
  results: Result[];
  baseline?: Result;
  stat?: (r: FitStats | "error" | null) => number | null;
  format?: (v: number) => string;
  render?: (r: Result) => React.ReactNode;
  children?: (fit: Slot) => React.ReactNode;
}) {
  const baseValue =
    stat && baseline && typeof baseline === "object" ? stat(baseline) : null;
  return (
    <tr className="border-b border-zinc-800/60">
      <td className="py-1 pr-3 text-xs text-zinc-500">{label}</td>
      {slots.map((fit, i) => {
        const r = results[i];
        if (children) {
          return (
            <td key={i} className="py-1 pr-3 text-zinc-200">
              {children(fit)}
            </td>
          );
        }
        if (render) {
          return (
            <td key={i} className="py-1 pr-3 text-zinc-200">
              {render(r)}
            </td>
          );
        }
        if (r === "error") {
          return (
            <td key={i} className="py-1 pr-3">
              <span className="text-rose-400">error</span>
            </td>
          );
        }
        const v = stat ? stat(r) : null;
        return (
          <td key={i} className="py-1 pr-3 text-zinc-200">
            {v == null ? (
              <span className="text-zinc-600">—</span>
            ) : (
              <>
                {format ? format(v) : v}
                {i > 0 && baseValue != null && format && (
                  <DeltaBadge value={v} base={baseValue} format={format} />
                )}
              </>
            )}
          </td>
        );
      })}
    </tr>
  );
}
