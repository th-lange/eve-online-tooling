import { Fragment, useMemo, useState } from "react";
import type { ProfitBreakdown } from "../../lib/api";
import {
  formatInt,
  formatIsk,
  formatPercent,
  sortBreakdowns,
  type SortDir,
  type SortKey,
} from "../../lib/format";

const MAX_ROWS = 500;

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "productName", label: "Item", numeric: false },
  { key: "profit", label: "Profit", numeric: true },
  { key: "roi", label: "ROI", numeric: true },
  { key: "margin", label: "Margin", numeric: true },
  { key: "profitPerUnit", label: "Profit/unit", numeric: true },
  { key: "productVolume", label: "Daily vol.", numeric: true },
];

export function ProfitTable({ rows }: { rows: ProfitBreakdown[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filter, setFilter] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [selectedMeta, setSelectedMeta] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<number | null>(null);

  const metaGroups = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.metaGroup) set.add(r.metaGroup);
    return [...set].sort();
  }, [rows]);

  function toggleMeta(m: string) {
    setSelectedMeta((prev) => {
      const next = new Set(prev);
      next.has(m) ? next.delete(m) : next.add(m);
      return next;
    });
  }

  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const min = minVolume.trim() === "" ? null : Number(minVolume);
    const filtered = rows.filter((r) => {
      if (needle && !r.productName.toLowerCase().includes(needle)) return false;
      if (min !== null && (r.productVolume ?? 0) < min) return false;
      // No meta selected = show all; otherwise the row's group must be ticked.
      if (selectedMeta.size > 0 && !(r.metaGroup && selectedMeta.has(r.metaGroup)))
        return false;
      return true;
    });
    return sortBreakdowns(filtered, sortKey, sortDir);
  }, [rows, filter, minVolume, selectedMeta, sortKey, sortDir]);

  const shown = view.slice(0, MAX_ROWS);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "productName" ? "asc" : "desc");
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          placeholder="Filter items…"
          className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <label className="flex items-center gap-1 text-xs text-zinc-400">
          Min daily volume
          <input
            value={minVolume}
            onChange={(e) => setMinVolume(e.currentTarget.value)}
            inputMode="numeric"
            placeholder="0"
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </label>
        {metaGroups.length > 1 &&
          metaGroups.map((m) => (
            <label
              key={m}
              className={`flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs ${
                selectedMeta.has(m)
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-800 text-zinc-400"
              }`}
            >
              <input
                type="checkbox"
                checked={selectedMeta.has(m)}
                onChange={() => toggleMeta(m)}
              />
              {m}
            </label>
          ))}
        <span className="ml-auto text-xs text-zinc-500">
          {view.length > MAX_ROWS
            ? `top ${MAX_ROWS} of ${view.length}`
            : `${view.length} of ${rows.length}`}
        </span>
      </div>

      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="w-6" />
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  onClick={() => toggleSort(c.key)}
                  className={`cursor-pointer select-none px-3 py-2 font-medium ${
                    c.numeric ? "text-right" : "text-left"
                  } hover:text-zinc-200`}
                >
                  {c.label}
                  {sortKey === c.key ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium">Market</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const open = expanded === r.blueprintTypeId;
              const incomplete = r.missingPrices.length > 0;
              return (
                <Fragment key={r.blueprintTypeId}>
                  <tr
                    onClick={() =>
                      setExpanded(open ? null : r.blueprintTypeId)
                    }
                    className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/40"
                  >
                    <td className="px-2 text-center text-zinc-500">
                      {open ? "▾" : "▸"}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-200">
                      {r.productName}
                      {incomplete && (
                        <span
                          title={`Missing prices for ${r.missingPrices.length} item(s) — numbers are incomplete`}
                          className="ml-1 text-amber-400"
                        >
                          ⚠
                        </span>
                      )}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        r.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {formatIsk(r.profit)}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        (r.roi ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {formatPercent(r.roi)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                      {formatPercent(r.margin)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                      {formatIsk(r.profitPerUnit)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                      {formatInt(r.productVolume)}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400">
                      {r.market ?? "—"}
                    </td>
                  </tr>
                  {open && <BreakdownRow row={r} />}
                </Fragment>
              );
            })}
            {view.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BreakdownRow({ row }: { row: ProfitBreakdown }) {
  return (
    <tr className="border-t border-zinc-800 bg-zinc-900/40">
      <td />
      <td colSpan={7} className="px-3 py-3">
        <div className="mb-2 text-xs text-zinc-400">
          {row.runs} run(s) · ME {row.me} · {formatInt(row.unitsProduced)} unit(s)
          · job fee {formatIsk(row.jobFee)}
          {row.blueprintCost > 0
            ? ` · blueprint ${formatIsk(row.blueprintCost)}`
            : ""}{" "}
          · revenue {formatIsk(row.revenue)}
        </div>
        <table className="w-full text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="text-left font-medium">Material</th>
              <th className="text-right font-medium">Qty</th>
              <th className="text-right font-medium">Unit</th>
              <th className="text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {row.materials.map((m) => (
              <tr key={m.typeId} className="text-zinc-300">
                <td className="py-0.5">
                  {m.name}
                  {m.unitPrice === null && (
                    <span className="ml-1 text-amber-400" title="No price">
                      ⚠
                    </span>
                  )}
                </td>
                <td className="text-right tabular-nums">
                  {formatInt(m.requiredQuantity)}
                </td>
                <td className="text-right tabular-nums">
                  {formatIsk(m.unitPrice)}
                </td>
                <td className="text-right tabular-nums">
                  {formatIsk(m.lineCost)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-zinc-800 font-medium text-zinc-200">
              <td className="py-0.5">Materials total</td>
              <td />
              <td />
              <td className="text-right tabular-nums">
                {formatIsk(row.materialCost)}
              </td>
            </tr>
          </tbody>
        </table>
      </td>
    </tr>
  );
}
