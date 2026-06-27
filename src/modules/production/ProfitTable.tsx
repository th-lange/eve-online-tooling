import { Fragment, useMemo, useState } from "react";
import type { ProfitBreakdown } from "../../lib/api";
import {
  formatDuration,
  formatInt,
  formatIsk,
  formatPercent,
  sortBreakdowns,
  unitCost,
  type SortKey,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { AddToListButton } from "../../components/AddToListButton";

const MAX_ROWS = 500;

/**
 * EVE in-game **Multibuy** format: one `name<TAB>quantity` per line. Lists the
 * shortfall actually bought (required − owned), skipping fully-stocked inputs.
 * Paste straight into the Multibuy window.
 */
function multibuyText(row: ProfitBreakdown): string {
  return row.materials
    .map((m) => ({ name: m.name, qty: Math.max(0, m.requiredQuantity - m.have) }))
    .filter((m) => m.qty > 0)
    .map((m) => `${m.name}\t${m.qty}`)
    .join("\n");
}

/** A Markdown cost overview for one build — totals plus the material list. */
function costMarkdown(row: ProfitBreakdown): string {
  const where = row.sellHub ? `sell @ ${row.sellHub}` : row.market ?? "";
  const out: string[] = [
    `## ${row.productName} ×${formatInt(row.unitsProduced)}${where ? ` (${where})` : ""}`,
    "",
    "| | ISK |",
    "| --- | ---: |",
    `| Revenue (sell) | ${formatIsk(row.revenue)} |`,
    `| Materials | ${formatIsk(row.materialCost)} |`,
    `| Job fee | ${formatIsk(row.jobFee)} |`,
  ];
  if (row.blueprintCost > 0) out.push(`| Blueprint | ${formatIsk(row.blueprintCost)} |`);
  if (row.inventionCost > 0) out.push(`| Invention | ${formatIsk(row.inventionCost)} |`);
  out.push(
    `| Cost/unit | ${formatIsk(unitCost(row))} |`,
    `| **Profit** | **${formatIsk(row.profit)}** |`,
    `| Profit/unit | ${formatIsk(row.profitPerUnit)} |`,
    `| Margin | ${formatPercent(row.margin)} |`,
    `| ROI | ${formatPercent(row.roi)} |`,
    "",
    "### Materials",
    "| Material | Qty | Unit | Cost |",
    "| --- | ---: | ---: | ---: |",
  );
  for (const m of row.materials) {
    out.push(
      `| ${m.name}${m.built ? " (built)" : ""} | ${formatInt(m.requiredQuantity)} | ${formatIsk(m.unitPrice)} | ${formatIsk(m.lineCost)} |`,
    );
  }
  out.push(`| **Total** | | | **${formatIsk(row.materialCost)}** |`);
  return out.join("\n");
}

const COLUMNS: SortColumn<SortKey>[] = [
  {
    key: "productName",
    label: "Item",
    numeric: false,
    description: "The item produced by this blueprint.",
  },
  {
    key: "productPrice",
    label: "Sell",
    numeric: true,
    description: "Product sell price per unit at the chosen market and price basis.",
  },
  {
    key: "unitCost",
    label: "Cost",
    numeric: true,
    description:
      "Production cost per unit — materials + job fee + blueprint + invention, amortized over units produced.",
  },
  {
    key: "roi",
    label: "ROI",
    numeric: true,
    description:
      "Profit ÷ total cost — the uncapped build-and-sell return on investment.",
  },
  {
    key: "margin",
    label: "Margin",
    numeric: true,
    description: "Profit ÷ revenue (capped at 100%).",
  },
  {
    key: "profitPerUnit",
    label: "Profit/item",
    numeric: true,
    description:
      "Net ISK per unit after materials, industry fees and taxes (can be negative).",
  },
  {
    key: "productVolume",
    label: "Volume",
    numeric: true,
    description: "Daily volume at the chosen market — a liquidity proxy.",
  },
];

const SORT_KEYS = COLUMNS.map((c) => c.key);

// Pure display: the page does the filtering, this sorts + renders.
export function ProfitTable({
  rows,
  onFavorite,
  onBlacklist,
}: {
  rows: ProfitBreakdown[];
  onFavorite: (r: ProfitBreakdown) => void;
  onBlacklist: (r: ProfitBreakdown) => void;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<SortKey>(
    "sort.production",
    SORT_KEYS,
    "profitPerUnit",
    "desc",
    ["productName"],
  );
  const [expanded, setExpanded] = useState<number | null>(null);

  const sorted = useMemo(
    () => sortBreakdowns(rows, sortKey, sortDir),
    [rows, sortKey, sortDir],
  );
  const shown = sorted.slice(0, MAX_ROWS);

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
              <th className="w-16" />
              {COLUMNS.map((c) => (
                <SortHeaderCell
                  key={c.key}
                  column={c}
                  active={sortKey === c.key}
                  dir={sortDir}
                  onClick={toggleSort}
                />
              ))}
              <th
                className="px-3 py-2 text-left font-medium"
                title="The market this row was priced at."
              >
                Market
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const open = expanded === r.blueprintTypeId;
              const incomplete = r.missingPrices.length > 0;
              const subtitle = [r.category, r.group, r.metaGroup]
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
                    <td className="px-2 whitespace-nowrap">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFavorite(r);
                        }}
                        title="Favorite"
                        className={
                          r.favorite
                            ? "text-amber-400"
                            : "text-zinc-600 hover:text-amber-400"
                        }
                      >
                        ★
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onBlacklist(r);
                        }}
                        title="Blacklist (hide from ranking)"
                        className="ml-2 text-zinc-600 hover:text-rose-400"
                      >
                        ✕
                      </button>
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
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-200">
                      {formatIsk(r.productPrice)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                      {formatIsk(unitCost(r))}
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
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        r.profitPerUnit >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {formatIsk(r.profitPerUnit)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                      {formatInt(r.productVolume)}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-400">
                      {r.sellHub ? (
                        <span title="Best hub to sell at">
                          <span className="text-emerald-400">↗ {r.sellHub}</span>
                        </span>
                      ) : (
                        (r.market ?? "—")
                      )}
                    </td>
                  </tr>
                  {open && <BreakdownRow row={r} />}
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-zinc-500">
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
  const [copied, setCopied] = useState<"md" | "mb" | null>(null);
  function copy(text: string, tag: "md" | "mb") {
    void navigator.clipboard?.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1200);
  }
  return (
    <tr className="border-t border-zinc-800 bg-zinc-900/40">
      <td />
      <td colSpan={9} className="px-3 py-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="text-xs text-zinc-400">
            {row.runs} run(s) · ME {row.me} · {formatInt(row.unitsProduced)} unit(s)
            {row.jobTimeSeconds > 0
              ? ` · build ${formatDuration(row.jobTimeSeconds)}`
              : ""}
            · job fee {formatIsk(row.jobFee)}
            {row.inventionCost > 0
              ? ` · invention ${formatIsk(row.inventionCost)}`
              : ""}
            {row.blueprintCost > 0
              ? ` · blueprint ${formatIsk(row.blueprintCost)}`
              : ""}{" "}
            · revenue {formatIsk(row.revenue)}
          </div>
          <div className="flex shrink-0 gap-1">
            <button
              onClick={() => copy(costMarkdown(row), "md")}
              title="Copy a Markdown cost overview to the clipboard"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              {copied === "md" ? "Copied ✓" : "Export"}
            </button>
            <button
              onClick={() => copy(multibuyText(row), "mb")}
              title="Copy the materials for the in-game Multibuy window"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              {copied === "mb" ? "Copied ✓" : "Multibuy"}
            </button>
            <AddToListButton
              items={row.materials
                .map((m) => ({
                  typeId: m.typeId,
                  quantity: Math.max(0, m.requiredQuantity - m.have),
                }))
                .filter((m) => m.quantity > 0)}
              label="2 list"
              title="Add this build's materials (the shortfall) to a shopping list"
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            />
          </div>
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
                  {m.have > 0 && (
                    <span
                      className="ml-1 rounded bg-emerald-900/60 px-1 text-[10px] text-emerald-300"
                      title={`You own ${m.have} — only the shortfall is bought`}
                    >
                      have {formatInt(m.have)}
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
