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

/** A duration in seconds as a compact `1d 2h 3m` (largest two units). */
export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: [number, string][] = [
    [d, "d"],
    [h, "h"],
    [m, "m"],
    [sec, "s"],
  ];
  return (
    parts
      .filter(([v]) => v > 0)
      .slice(0, 2)
      .map(([v, u]) => `${v}${u}`)
      .join(" ") || "0s"
  );
}

export type SortKey =
  | "productName"
  | "profit"
  | "roi"
  | "margin"
  | "profitPerUnit"
  | "productPrice"
  | "unitCost"
  | "productVolume";
export type SortDir = "asc" | "desc";

/**
 * Production cost per unit: materials + job fee + blueprint + invention,
 * amortized over the units produced. `null` when nothing is produced.
 */
export function unitCost(row: ProfitBreakdown): number | null {
  if (row.unitsProduced <= 0) return null;
  return (
    (row.materialCost + row.jobFee + row.blueprintCost + row.inventionCost) /
    row.unitsProduced
  );
}

/**
 * Nulls-last comparator helper: returns a definitive ordering when either
 * value is `null`/`undefined` (nulls always sort last, regardless of
 * direction), or `null` to signal "compare normally".
 */
function compareNullsLast(av: unknown, bv: unknown): number | null {
  if (av == null && bv == null) return 0;
  if (av == null) return 1; // nulls last regardless of dir
  if (bv == null) return -1;
  return null;
}

/**
 * Generic row sort by a field name. Strings compare lexically; numbers
 * numerically with `null`/`undefined` sorted last. Returns a new array.
 *
 * By default `null`/`undefined` values are treated as the smallest possible
 * number (so they sort first ascending, last descending). Pass
 * `{ nullsLast: true }` to force them to the end regardless of `dir`.
 */
export function sortRows<T>(
  rows: T[],
  key: keyof T,
  dir: SortDir,
  opts?: { nullsLast?: boolean },
): T[] {
  const d = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (opts?.nullsLast) {
      const nullOrder = compareNullsLast(av, bv);
      if (nullOrder !== null) return nullOrder;
    }
    if (typeof av === "string" || typeof bv === "string") {
      return d * String(av ?? "").localeCompare(String(bv ?? ""));
    }
    const an = av == null ? Number.NEGATIVE_INFINITY : Number(av);
    const bn = bv == null ? Number.NEGATIVE_INFINITY : Number(bv);
    return d * (an - bn);
  });
}

function value(row: ProfitBreakdown, key: SortKey): number | string | null {
  switch (key) {
    case "productName":
      return row.productName;
    case "profit":
      return row.profit;
    case "roi":
      return row.roi;
    case "margin":
      return row.margin;
    case "profitPerUnit":
      return row.profitPerUnit;
    case "productPrice":
      return row.productPrice;
    case "unitCost":
      return unitCost(row);
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
    const nullOrder = compareNullsLast(av, bv);
    if (nullOrder !== null) return nullOrder;
    if (typeof av === "string" && typeof bv === "string") {
      return factor * av.localeCompare(bv);
    }
    return factor * ((av as number) - (bv as number));
  });
}
