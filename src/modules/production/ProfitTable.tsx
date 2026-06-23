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
  { key: "productPrice", label: "Target", numeric: true },
  { key: "productVolume", label: "Volume", numeric: true },
];

// Pure display: the page does the filtering, this sorts + renders.
export function ProfitTable({ rows }: { rows: ProfitBreakdown[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<number | null>(null);

  const sorted = useMemo(
    () => sortBreakdowns(rows, sortKey, sortDir),
    [rows, sortKey, sortDir],
  );
  const shown = sorted.slice(0, MAX_ROWS);

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
      <div className="mb-1 text-xs text-zinc-500">
        {rows.length > MAX_ROWS
          ? `Showing top ${MAX_ROWS} of ${rows.length}`
          : `${rows.length} item(s)`}
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
              const subtitle = [r.category, r.metaGroup]
                .filter(Boolean)
                .join(" · ");
              return (
                <Fragment key={r.blueprintTypeId}>
                  <tr
                    onClick={() => setExpanded(open ? null : r.blueprintTypeId)}
                    className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/40"
                  >
                    <td className="px-2 text-center text-zinc-500">
                      {open ? "▾" : "▸"}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-zinc-200">
                        {r.productName}
                        {incomplete && (
                          <span
                            title={`Missing prices for ${r.missingPrices.length} item(s) — numbers are incomplete`}
                            className="ml-1 text-amber-400"
                          >
                            ⚠
                          </span>
                        )}
                      </div>
                      {subtitle && (
                        <div className="text-xs text-zinc-500">{subtitle}</div>
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
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                      {formatIsk(r.productPrice)}
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-zinc-500">
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
      <td colSpan={8} className="px-3 py-3">
        <div className="mb-2 text-xs text-zinc-400">
          {row.runs} run(s) · ME {row.me} · {formatInt(row.unitsProduced)} unit(s)
          · job fee {formatIsk(row.jobFee)}
          {row.inventionCost > 0
            ? ` · invention ${formatIsk(row.inventionCost)}`
            : ""}
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
                  {m.built && (
                    <span
                      className="ml-1 rounded bg-sky-900/60 px-1 text-[10px] text-sky-300"
                      title="Cheaper to build than buy"
                    >
                      build
                    </span>
                  )}
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

        {row.invention && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-medium text-zinc-400">
              Invention — {(row.invention.probability * 100).toFixed(1)}% chance ×{" "}
              {row.invention.runsPerSuccess} runs/success ={" "}
              {formatIsk(row.invention.perUnit)}/unit
            </div>
            <table className="w-full text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="text-left font-medium">Per attempt</th>
                  <th className="text-right font-medium">Qty</th>
                  <th className="text-right font-medium">Unit</th>
                  <th className="text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {row.invention.datacores.map((d) => (
                  <tr key={d.typeId} className="text-zinc-300">
                    <td className="py-0.5">
                      {d.name}
                      {d.unitPrice === null && (
                        <span className="ml-1 text-amber-400" title="No price">
                          ⚠
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatInt(d.requiredQuantity)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatIsk(d.unitPrice)}
                    </td>
                    <td className="text-right tabular-nums">
                      {formatIsk(d.lineCost)}
                    </td>
                  </tr>
                ))}
                <tr className="text-zinc-400">
                  <td className="py-0.5">Invention job fee</td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums">
                    {formatIsk(row.invention.inventionJobFee)}
                  </td>
                </tr>
                <tr className="text-zinc-400">
                  <td className="py-0.5">T1 BPC copy fee</td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums">
                    {formatIsk(row.invention.copyFee)}
                  </td>
                </tr>
                <tr className="border-t border-zinc-800 font-medium text-zinc-200">
                  <td className="py-0.5">Per attempt</td>
                  <td />
                  <td />
                  <td className="text-right tabular-nums">
                    {formatIsk(row.invention.attemptCost)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </td>
    </tr>
  );
}
