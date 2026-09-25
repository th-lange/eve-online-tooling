import { useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { BarChart2, Plus, X } from "lucide-react";
import {
  fittingAmmoTable,
  fittingLoadAmmo,
  fittingSimulate,
  type Fit,
  type FitStats,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { FIT_EPS, km } from "./fitHelpers";
import { useFitLibrary } from "./useFitLibrary";
import { useFitState } from "./useFitEditorContext";
import { DpsRangeOverlayChart, type DpsRangeSeries } from "./StatsPanels";

// A hard ceiling, not a design target — Pyfa-style overlay comparisons rarely
// need more than a handful of curves before the chart/table get unreadable.
const MAX_SLOTS = 6;

type Slot = Fit | null;
type Result = FitStats | "error" | null;

/** Do two comparable values (numbers tolerant of float noise, everything
 *  else by strict equality) differ? Backs the diff-highlight cells. */
function valuesDiffer(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) > FIT_EPS * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return a !== b;
}

/**
 * Side-by-side comparison of 2–6 fits (#880: raised from a fixed 2–3):
 * pick fits from the shared library (same source as the Workbench's
 * picker) — or the same fit twice with a different ammo override — apply
 * the Workbench's current target/damage profile to all of them, simulate
 * together, diff every stat against the first column (cell-level
 * highlight, not colour alone), and overlay their DPS-vs-range curves on
 * one chart.
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
  const { skillSource, damageProfile, targetProfile } = useFitState();
  const [slots, setSlots] = useState<Slot[]>([currentFit, null]);
  const [results, setResults] = useState<Result[]>([null, null]);
  // Per-slot ammo override (#880): lets the same fit appear twice with
  // different charges loaded (Void vs Null) instead of only comparing
  // distinct saved fits.
  const [ammoOverride, setAmmoOverride] = useState<(number | null)[]>([
    null,
    null,
  ]);
  const [pending, setPending] = useState(false);

  const ammoQueries = useQueries({
    queries: slots.map((fit) => ({
      queryKey: ["fitting", "ammoTable-compare", fit, skillSource],
      queryFn: () => fittingAmmoTable(fit!, skillSource),
      enabled: fit != null,
    })),
  });

  const setSlot = (i: number, fit: Slot) => {
    setSlots((prev) => prev.map((s, j) => (j === i ? fit : s)));
    setResults((prev) => prev.map((r, j) => (j === i ? null : r)));
    setAmmoOverride((prev) => prev.map((a, j) => (j === i ? null : a)));
  };

  const setAmmo = (i: number, typeId: number | null) => {
    setAmmoOverride((prev) => prev.map((a, j) => (j === i ? typeId : a)));
    setResults((prev) => prev.map((r, j) => (j === i ? null : r)));
  };

  const addSlot = () => {
    if (slots.length >= MAX_SLOTS) return;
    setSlots((prev) => [...prev, null]);
    setResults((prev) => [...prev, null]);
    setAmmoOverride((prev) => [...prev, null]);
  };

  const removeSlot = (i: number) => {
    setSlots((prev) => prev.filter((_, j) => j !== i));
    setResults((prev) => prev.filter((_, j) => j !== i));
    setAmmoOverride((prev) => prev.filter((_, j) => j !== i));
  };

  const simulateAll = async () => {
    setPending(true);
    try {
      const next = await Promise.all(
        slots.map(async (fit, i): Promise<Result> => {
          if (!fit) return null;
          try {
            const ammoId = ammoOverride[i];
            const loaded =
              ammoId != null ? await fittingLoadAmmo(fit, ammoId) : fit;
            return await fittingSimulate(
              loaded,
              skillSource,
              damageProfile,
              undefined,
              targetProfile,
            );
          } catch {
            return "error" as const;
          }
        }),
      );
      setResults(next);
    } finally {
      setPending(false);
    }
  };

  const canSimulate = slots.some((s) => s != null);
  const baseline = results[0];

  const series = slots
    .map((fit, i): DpsRangeSeries | null => {
      const r = results[i];
      if (!fit || !r || typeof r !== "object" || !r.dpsRangeCurve) return null;
      const ammoId = ammoOverride[i];
      const ammoName =
        ammoId != null
          ? (ammoQueries[i]?.data?.find((a) => a.typeId === ammoId)?.name ??
            null)
          : null;
      return {
        label: `${fit.name}${ammoName ? ` (${ammoName})` : ""}`,
        curve: r.dpsRangeCurve,
      };
    })
    .filter((s): s is DpsRangeSeries => s != null);

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
        {slots.map((slot, i) => {
          const ammoOptions = ammoQueries[i]?.data ?? [];
          return (
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
              {slot && ammoOptions.length > 0 && (
                <label
                  className="flex flex-col gap-1 text-xs text-zinc-400"
                  title="Load a different charge for this comparison only — doesn't change the saved fit"
                >
                  Ammo
                  <select
                    value={ammoOverride[i] ?? ""}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setAmmo(i, v ? Number(v) : null);
                    }}
                    className="w-36 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                  >
                    <option value="">fit's own ammo</option>
                    {ammoOptions.map((a) => (
                      <option key={a.typeId} value={a.typeId}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
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
          );
        })}

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
              <StatRow
                label="Fit name"
                slots={slots}
                results={results}
                baselineFit={slots[0]}
                diffKey={(fit) => fit?.name ?? null}
              >
                {(fit) => fit?.name ?? "—"}
              </StatRow>
              <StatRow
                label="Ammo"
                slots={slots}
                results={results}
                diffKey={(_fit, _r, i) => ammoOverride[i]}
                render={(_r, fit, i) => {
                  if (!fit) return <span className="text-zinc-600">—</span>;
                  const ammoId = ammoOverride[i];
                  if (ammoId == null)
                    return (
                      <span className="text-zinc-500">fit's own ammo</span>
                    );
                  const name = ammoQueries[i]?.data?.find(
                    (a) => a.typeId === ammoId,
                  )?.name;
                  return (
                    <span className="text-zinc-200">
                      {name ?? `#${ammoId}`}
                    </span>
                  );
                }}
              />
              <StatRow
                label="Paper DPS"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) =>
                  r && typeof r === "object" ? (r.dps?.total ?? null) : null
                }
                format={(v) => formatInt(Math.round(v))}
              />
              <StatRow
                label="EHP"
                slots={slots}
                results={results}
                baseline={baseline}
                stat={(r) =>
                  r && typeof r === "object" ? (r.tank?.ehp ?? null) : null
                }
                format={(v) => formatInt(v)}
              />
              <StatRow
                label="Cap"
                slots={slots}
                results={results}
                diffKey={(_fit, r) => {
                  const cap =
                    r && typeof r === "object" ? r.capacitor : undefined;
                  return cap ? [cap.stable, cap.stablePct] : null;
                }}
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
                  r && typeof r === "object"
                    ? (r.targeting?.lockRange ?? null)
                    : null
                }
                format={(v) => km(v)}
              />
            </tbody>
          </table>
        </div>
      )}

      {results.some((r) => r != null) && (
        <div className="mt-4 border-t border-zinc-800 pt-3">
          <h4 className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
            DPS vs range
          </h4>
          <DpsRangeOverlayChart series={series} />
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
 *  `stat` extractor + `format`ter that also drives the delta badge.
 *  `diffKey` (defaulting to `stat` when omitted) drives the cell-level
 *  diff highlight (#880) against the first column — a distinguishing
 *  amber ring/background plus a "≠" glyph, never colour alone, so it
 *  survives grayscale rendering and reaches screen readers. Identical
 *  values across every column highlight nothing. */
function StatRow({
  label,
  slots,
  results,
  baseline,
  baselineFit,
  stat,
  format,
  render,
  children,
  diffKey,
}: {
  label: string;
  slots: Slot[];
  results: Result[];
  baseline?: Result;
  baselineFit?: Slot;
  stat?: (r: Result) => number | null;
  format?: (v: number) => string;
  render?: (r: Result, fit: Slot, i: number) => ReactNode;
  children?: (fit: Slot) => ReactNode;
  diffKey?: (fit: Slot, r: Result, i: number) => unknown;
}) {
  const baseValue =
    stat && baseline && typeof baseline === "object" ? stat(baseline) : null;
  const keyOf = diffKey ?? (stat ? (_fit: Slot, r: Result) => stat(r) : null);
  const baseKey = keyOf
    ? keyOf(baselineFit ?? slots[0], baseline ?? null, 0)
    : null;
  return (
    <tr className="border-b border-zinc-800/60">
      <td className="py-1 pr-3 text-xs text-zinc-500">{label}</td>
      {slots.map((fit, i) => {
        const r = results[i];
        const differs =
          i > 0 &&
          results[0] != null &&
          keyOf != null &&
          valuesDiffer(keyOf(fit, r, i), baseKey);
        const cellCls = differs
          ? "bg-amber-950/40 ring-1 ring-inset ring-amber-700/60"
          : "";
        const marker = differs ? (
          <span
            className="mr-1 text-amber-500"
            title={`Differs from ${label} in Fit 1`}
            aria-label="differs from baseline"
          >
            ≠
          </span>
        ) : null;
        if (children) {
          return (
            <td key={i} className={`py-1 pr-3 text-zinc-200 ${cellCls}`}>
              {marker}
              {children(fit)}
            </td>
          );
        }
        if (render) {
          return (
            <td key={i} className={`py-1 pr-3 text-zinc-200 ${cellCls}`}>
              {marker}
              {render(r, fit, i)}
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
          <td key={i} className={`py-1 pr-3 text-zinc-200 ${cellCls}`}>
            {v == null ? (
              <span className="text-zinc-600">—</span>
            ) : (
              <>
                {marker}
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
