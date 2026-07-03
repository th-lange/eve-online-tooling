import { Fragment, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Star,
  TrendingUp,
} from "lucide-react";
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
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
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
    .map((m) => ({
      name: m.name,
      qty: Math.max(0, m.requiredQuantity - m.have),
    }))
    .filter((m) => m.qty > 0)
    .map((m) => `${m.name}\t${m.qty}`)
    .join("\n");
}

/** A Markdown cost overview for one build — totals plus the material list. */
function costMarkdown(row: ProfitBreakdown): string {
  const where = row.sellHub ? `sell @ ${row.sellHub}` : (row.market ?? "");
  const out: string[] = [
    `## ${row.productName} ×${formatInt(row.unitsProduced)}${where ? ` (${where})` : ""}`,
    "",
    "| | ISK |",
    "| --- | ---: |",
    `| Revenue (sell) | ${formatIsk(row.revenue)} |`,
    `| Materials | ${formatIsk(row.materialCost)} |`,
    `| Job fee | ${formatIsk(row.jobFee)} |`,
  ];
  if (row.blueprintCost > 0)
    out.push(`| Blueprint | ${formatIsk(row.blueprintCost)} |`);
  if (row.inventionCost > 0)
    out.push(`| Invention | ${formatIsk(row.inventionCost)} |`);
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
    description:
      "Product sell price per unit at the chosen market and price basis.",
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
  // Scale the inline ROI bars relative to the strongest ROI on screen, so the
  // bar length reads as "how good is this row vs. the best one here".
  const maxAbsRoi = useMemo(
    () => Math.max(1, ...shown.map((r) => Math.abs(r.roi ?? 0))),
    [shown],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No builds match your filters"
        hint="Loosen a filter — lower the min ROI/volume, clear the category, or turn off Owned-only — to bring rows back."
      />
    );
  }

  return (
    <div>
      <div className="mb-1 text-xs text-zinc-400">
        {rows.length > MAX_ROWS
          ? `Showing top ${MAX_ROWS} of ${rows.length}`
          : `${rows.length} item(s)`}
      </div>
      <div className="rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-zinc-900 text-zinc-400 shadow-[0_1px_0_0_theme(colors.zinc.800)]">
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
                  demoted={c.key === "productVolume"}
                />
              ))}
              <th
                className="border-l border-zinc-800/60 px-3 py-2 text-left text-xs font-medium text-zinc-500"
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
                    <td className="px-2 text-zinc-400">
                      <span className="flex items-center justify-center">
                        {open ? (
                          <ChevronDown size={16} />
                        ) : (
                          <ChevronRight size={16} />
                        )}
                      </span>
                    </td>
                    <td className="px-2 whitespace-nowrap">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onFavorite(r);
                        }}
                        title="Favorite"
                        aria-label={r.favorite ? "Unfavorite" : "Favorite"}
                        className={`rounded p-1 ${
                          r.favorite
                            ? "text-amber-400"
                            : "text-zinc-400 hover:text-amber-400"
                        }`}
                      >
                        <Star
                          size={15}
                          fill={r.favorite ? "currentColor" : "none"}
                        />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onBlacklist(r);
                        }}
                        title="Blacklist (hide from ranking)"
                        aria-label="Blacklist"
                        className="ml-1 rounded p-1 text-zinc-400 hover:text-rose-400"
                      >
                        <Ban size={15} />
                      </button>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-zinc-200">
                        {r.productName}
                        {incomplete && (
                          <AlertTriangle
                            size={13}
                            className="ml-1 inline align-text-bottom text-amber-400"
                            aria-label={`Missing prices for ${r.missingPrices.length} item(s) — numbers are incomplete`}
                          />
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
                    <td className="px-3 py-1.5 text-right">
                      <div
                        className={`text-[15px] font-semibold tabular-nums ${
                          r.profitPerUnit >= 0
                            ? "text-emerald-400"
                            : "text-rose-400"
                        }`}
                      >
                        {formatIsk(r.profitPerUnit)}
                      </div>
                      <RoiBar roi={r.roi} max={maxAbsRoi} />
                    </td>
                    <td className="border-l border-zinc-800/60 px-3 py-1.5 text-right text-xs tabular-nums text-zinc-500">
                      {formatInt(r.productVolume)}
                    </td>
                    <td className="border-l border-zinc-800/60 px-3 py-1.5 text-xs text-zinc-500">
                      {r.sellHub ? (
                        <span
                          className="inline-flex items-center gap-1 text-emerald-400"
                          title="Best hub to sell at"
                        >
                          <TrendingUp size={13} />
                          {r.sellHub}
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
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A thin horizontal bar whose length encodes ROI relative to the strongest ROI
 * currently on screen — a quick "how good is this row" cue next to the profit.
 */
function RoiBar({ roi, max }: { roi: number | null; max: number }) {
  const v = roi ?? 0;
  const pct = Math.min(100, (Math.abs(v) / max) * 100);
  return (
    <div className="mt-0.5 ml-auto h-1 w-16 overflow-hidden rounded-full bg-zinc-800">
      <div
        className={`h-full rounded-full ${
          v >= 0 ? "bg-emerald-500/70" : "bg-rose-500/70"
        }`}
        style={{ width: `${pct}%`, marginLeft: v >= 0 ? undefined : "auto" }}
      />
    </div>
  );
}

/** A centred empty state: a headline plus a concrete next step. */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded border border-dashed border-zinc-800 p-10 text-center">
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {hint && (
        <div className="mx-auto mt-1 max-w-md text-xs text-zinc-500">
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Placeholder rows shown while a full re-price is in flight. The table shape is
 * known up front, so we render shimmering rows instead of one bare gray line.
 */
export function TableSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded border border-zinc-800">
      <div className="border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500">
        Pricing the whole catalogue at the chosen market…
      </div>
      <div className="divide-y divide-zinc-800/60">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3 py-2.5">
            <div className="h-3 w-3 animate-pulse rounded-full bg-zinc-800" />
            <div className="h-3 flex-1 animate-pulse rounded bg-zinc-800" />
            <div className="h-3 w-16 animate-pulse rounded bg-zinc-800" />
            <div className="h-3 w-12 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-20 animate-pulse rounded bg-zinc-800" />
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownRow({ row }: { row: ProfitBreakdown }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <tr className="border-t border-zinc-800 bg-zinc-900/40">
      <td />
      <td colSpan={9} className="px-3 py-3">
        <div className="mb-2 flex items-start justify-between gap-3">
          <div className="text-xs text-zinc-400">
            {row.runs} run(s) · ME {row.me} · {formatInt(row.unitsProduced)}{" "}
            unit(s)
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
              className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              {copied === "md" ? (
                <>
                  <Check size={12} /> Copied
                </>
              ) : (
                "Export"
              )}
            </button>
            <button
              onClick={() => copy(multibuyText(row), "mb")}
              title="Copy the materials for the in-game Multibuy window"
              className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              {copied === "mb" ? (
                <>
                  <Check size={12} /> Copied
                </>
              ) : (
                "Multibuy"
              )}
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
                    <AlertTriangle
                      size={12}
                      className="ml-1 inline align-text-bottom text-amber-400"
                      aria-label="No price"
                    />
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
              Invention — {formatPercent(row.invention.probability)} chance ×{" "}
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
                        <AlertTriangle
                          size={12}
                          className="ml-1 inline align-text-bottom text-amber-400"
                          aria-label="No price"
                        />
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
