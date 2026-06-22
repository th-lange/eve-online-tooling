// Display helpers for ISK amounts, percentages, and integers, plus a pure
// sort comparator for profit rows (kept here so it's unit-testable).
import type { ProfitBreakdown } from "./api";

const isk = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const int = new Intl.NumberFormat("en-US");

export function formatIsk(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return isk.format(n);
}

export function formatInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return int.format(n);
}

export function formatPercent(frac: number | null | undefined): string {
  if (frac === null || frac === undefined || Number.isNaN(frac)) return "—";
  return `${(frac * 100).toFixed(1)}%`;
}

export type SortKey =
  | "productName"
  | "profit"
  | "margin"
  | "profitPerUnit"
  | "productVolume";
export type SortDir = "asc" | "desc";

function value(row: ProfitBreakdown, key: SortKey): number | string | null {
  switch (key) {
    case "productName":
      return row.productName;
    case "profit":
      return row.profit;
    case "margin":
      return row.margin;
    case "profitPerUnit":
      return row.profitPerUnit;
    case "productVolume":
      return row.productVolume;
  }
}

/** Sort a copy of `rows` by `key`/`dir`. Nulls always sort last. */
export function sortBreakdowns(
  rows: ProfitBreakdown[],
  key: SortKey,
  dir: SortDir,
): ProfitBreakdown[] {
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a, key);
    const bv = value(b, key);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last regardless of dir
    if (bv === null) return -1;
    if (typeof av === "string" && typeof bv === "string") {
      return factor * av.localeCompare(bv);
    }
    return factor * ((av as number) - (bv as number));
  });
}
