import { type ReactNode } from "react";
import { RefreshCw, X } from "lucide-react";
import {
  type OwnedBlueprint,
  type PriceBasis,
  type ProfitBreakdown,
} from "../../lib/api";
import { formatIsk, formatPercent } from "../../lib/format";
import { EmptyState } from "./ProfitTable";
import type { ResultsView, Tab, ImportedBlueprint } from "./types";

// Presentational + form components and helpers extracted from ProductionPage (#341).

const BASES: { value: PriceBasis; label: string }[] = [
  { value: "sellPercentile", label: "Sell (percentile)" },
  { value: "buyPercentile", label: "Buy (percentile)" },
  { value: "sellMin", label: "Sell (min)" },
  { value: "buyMax", label: "Buy (max)" },
  { value: "averagePrice", label: "Weighted average" },
  { value: "adjustedPrice", label: "Adjusted (CCP)" },
];

/**
 * Sticky dirty indicator pinned to the bottom of the results pane: pricing
 * settings have changed since the table was last priced, so re-price in place
 * instead of scrolling back up to Calculate (#222).
 */
export function StaleBar({
  dirtyCount,
  pending,
  auto,
  onToggleAuto,
  onRecalc,
}: {
  dirtyCount: number;
  pending: boolean;
  auto: boolean;
  onToggleAuto: () => void;
  onRecalc: () => void;
}) {
  return (
    <div className="sticky bottom-0 z-20 -mx-6 mt-3 flex items-center justify-between border-t border-amber-500/30 bg-zinc-900/95 px-6 py-2 backdrop-blur">
      <span className="flex items-center gap-2 text-xs text-amber-300">
        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
        {dirtyCount} setting{dirtyCount === 1 ? "" : "s"} changed · prices are
        stale
      </span>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          <input type="checkbox" checked={auto} onChange={onToggleAuto} />
          Auto
        </label>
        <button
          onClick={onRecalc}
          disabled={pending}
          className="flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <RefreshCw size={13} className={pending ? "animate-spin" : ""} />
          {pending ? "Pricing…" : "Re-price"}
        </button>
      </div>
    </div>
  );
}

/** A removable-chip bar showing every active client-side filter (#223). */
export function FilterChips({
  filters,
  onReset,
}: {
  filters: { key: string; label: string; clear: () => void }[];
  onReset: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-zinc-500">Filters:</span>
      {filters.map((f) => (
        <button
          key={f.key}
          onClick={f.clear}
          title={`Remove filter: ${f.label}`}
          className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200 hover:border-zinc-600 hover:bg-zinc-700"
        >
          {f.label}
          <X size={12} className="text-zinc-400" />
        </button>
      ))}
      <button
        onClick={onReset}
        className="ml-1 rounded px-1.5 py-0.5 text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
      >
        Reset all
      </button>
    </div>
  );
}

/**
 * Verdict banner for the "Paste list" filter: given the pasted item names,
 * split into those worth building & selling (ROI at or above the requested
 * minimum), those below it, and those with no manufacturable product here.
 * Answers "does it make sense to sell?" at a glance above the filtered table.
 */
export function PasteVerdict({
  worth,
  skip,
  notBuildable,
  minRoiPct,
}: {
  worth: string[];
  skip: string[];
  notBuildable: string[];
  minRoiPct: number;
}) {
  const total = worth.length + skip.length + notBuildable.length;
  return (
    <div className="mt-3 space-y-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-zinc-400">{total} pasted:</span>
        <span className="text-emerald-400">
          {worth.length} worth selling (ROI ≥ {minRoiPct}%)
        </span>
        <span className="text-amber-400">{skip.length} below ROI</span>
        <span className="text-zinc-500">
          {notBuildable.length} not manufacturable
        </span>
      </div>
      {notBuildable.length > 0 && (
        <div className="text-zinc-500">
          <span className="text-zinc-400">No blueprint here:</span>{" "}
          {notBuildable.join(", ")}
        </div>
      )}
    </div>
  );
}

export function ViewTabs({
  view,
  onChange,
  counts,
}: {
  view: ResultsView;
  onChange: (v: ResultsView) => void;
  counts: { favorites: number; blacklist: number; library: number };
}) {
  const tabs: { value: ResultsView; label: string }[] = [
    { value: "opportunities", label: "Opportunities" },
    { value: "favorites", label: `Favorites (${counts.favorites})` },
    { value: "blacklist", label: `Blacklist (${counts.blacklist})` },
    { value: "library", label: `Library (${counts.library})` },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            view === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function BlueprintLibrary({
  owned,
  imported,
  onImport,
}: {
  owned: OwnedBlueprint[];
  imported: ImportedBlueprint[];
  onImport: (next: ImportedBlueprint[]) => void;
}) {
  function exportJson() {
    const payload = {
      owned: owned.map((b) => ({
        typeId: b.typeId,
        name: b.name,
        me: b.materialEfficiency,
        te: b.timeEfficiency,
        runs: b.runs,
      })),
      imported,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "blueprint-library.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function importJson(file: File) {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text);
        const list: unknown[] = Array.isArray(parsed)
          ? parsed
          : (parsed.imported ?? parsed.owned ?? []);
        const next: ImportedBlueprint[] = [];
        for (const item of list) {
          const o = item as Record<string, unknown>;
          const typeId = Number(o.typeId);
          if (!typeId) continue;
          next.push({
            typeId,
            name: String(o.name ?? `Type ${typeId}`),
            me: Number(o.me ?? o.materialEfficiency ?? 0),
            te: Number(o.te ?? o.timeEfficiency ?? 0),
          });
        }
        // Merge with existing imports (new entries override by typeId).
        const merged = new Map(imported.map((b) => [b.typeId, b]));
        for (const b of next) merged.set(b.typeId, b);
        onImport([...merged.values()]);
      } catch {
        alert("Couldn't parse that file as a blueprint library JSON.");
      }
    });
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <button
          onClick={exportJson}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Export JSON
        </button>
        <label className="cursor-pointer rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
          Import JSON
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) importJson(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <span className="text-xs text-zinc-500">
          Imported blueprints model BPs you don't own — their ME/TE feed the
          ranking.
        </span>
      </div>
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Blueprint</th>
              <th className="px-3 py-2 text-left font-medium">Owner</th>
              <th className="px-3 py-2 text-right font-medium">Runs</th>
              <th className="px-3 py-2 text-right font-medium">ME</th>
              <th className="px-3 py-2 text-right font-medium">TE</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {owned.map((b, i) => (
              <tr key={`o${i}`} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">{b.name}</td>
                <td className="px-3 py-1.5 text-zinc-400">
                  {b.characterName}
                  {b.corporation ? " (corp)" : ""}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {b.runs === -1 ? "∞ (BPO)" : b.runs}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                  {b.materialEfficiency}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                  {b.timeEfficiency}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {b.quantity}
                </td>
                <td />
              </tr>
            ))}
            {imported.map((b) => (
              <tr
                key={`i${b.typeId}`}
                className="border-t border-zinc-800 bg-sky-950/20"
              >
                <td className="px-3 py-1.5 text-zinc-200">
                  {b.name}
                  <span className="ml-1 rounded bg-sky-900/60 px-1 text-[10px] text-sky-300">
                    imported
                  </span>
                </td>
                <td className="px-3 py-1.5 text-zinc-500">—</td>
                <td className="px-3 py-1.5 text-right text-zinc-500">—</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                  {b.me}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                  {b.te}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-500">—</td>
                <td className="px-2 text-center">
                  <button
                    onClick={() =>
                      onImport(imported.filter((x) => x.typeId !== b.typeId))
                    }
                    title="Remove imported blueprint"
                    className="text-zinc-600 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {owned.length === 0 && imported.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-zinc-500">
                  No blueprints. Log in a character, or import a library JSON.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ListView({
  items,
  rowsByType,
  removeLabel,
  onRemove,
  emptyTitle,
  emptyHint,
}: {
  items: { typeId: number; name: string }[];
  rowsByType: Map<number, ProfitBreakdown>;
  removeLabel: string;
  onRemove: (typeId: number) => void;
  emptyTitle: string;
  emptyHint: string;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} hint={emptyHint} />;
  }
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {items.map((it) => {
            const r = rowsByType.get(it.typeId);
            return (
              <tr key={it.typeId} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">{it.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {r
                    ? `${formatIsk(r.profitPerUnit)}/item · ${formatPercent(r.roi)} ROI`
                    : ""}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => onRemove(it.typeId)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {removeLabel}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- small helpers / components ---

export function Tabs({
  tab,
  onChange,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
}) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "item", label: "Item" },
    { value: "market", label: "Market" },
    { value: "industry", label: "Industry" },
    { value: "thresholds", label: "Thresholds" },
    { value: "paste", label: "Paste list" },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

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

export function CheckboxGroup({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) {
    return <div className="text-xs text-zinc-600">—</div>;
  }
  return (
    <div className="flex max-h-40 flex-wrap gap-1 overflow-auto">
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

export function BasisSelect({
  value,
  onChange,
}: {
  value: PriceBasis;
  onChange: (b: PriceBasis) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as PriceBasis)}
      className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
    >
      {BASES.map((b) => (
        <option key={b.value} value={b.value}>
          {b.label}
        </option>
      ))}
    </select>
  );
}

export function Num({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-sm text-zinc-400">
      {children}
    </div>
  );
}
