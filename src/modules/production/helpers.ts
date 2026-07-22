// Small pure helpers for the Production module, kept out of the component
// files so react-refresh can hot-reload those cleanly.

import type { ProfitBreakdown } from "../../lib/api";

// Meta groups that never make sense to manufacture-and-sell in the ranked
// list: Abyssal mods can't be built at all (mutaplasmid-only); Officer
// items drop only from rare NPCs (never manufacturable); Faction/Storyline/
// Deadspace are LP-store/NPC-drop lines a builder has no reason to chase
// even when a blueprint exists. Tech I/II are unaffected — EVE's meta
// groups are mutually exclusive, so this never touches plain T2.
const EXCLUDED_META_GROUPS = new Set([
  "Abyssal",
  "Faction",
  "Storyline",
  "Deadspace",
  "Officer",
]);

/** Whether a row's meta group is one of the always-exclude special lines
 *  (Abyssal/Faction/Storyline/Deadspace/Officer) — see
 *  [`EXCLUDED_META_GROUPS`]. */
export function isExcludedMetaGroup(
  metaGroup: string | null | undefined,
): boolean {
  return metaGroup != null && EXCLUDED_META_GROUPS.has(metaGroup);
}

/** Distinct names (first occurrence wins, case-insensitive), preserving the
 *  original casing and input order — used to normalize a pasted item list. */
export function dedupNames(items: { name: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { name } of items) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface PasteVerdictResult {
  /** Worth building & selling: ROI at or above the requested minimum. */
  worth: string[];
  /** Manufacturable, but ROI is below the minimum (or unknowable). */
  skip: string[];
  /** No manufacturable product with that name in the priced set. */
  notBuildable: string[];
}

/** Classify pasted item names against the priced rows into build-and-sell
 *  verdict buckets — the "does it make sense to sell?" answer. An item is
 *  `worth` when its ROI (profit / cost) is at or above `minRoi` (a fraction,
 *  e.g. 0.05 = 5%); a null ROI (zero cost) can't clear the bar, so it's `skip`. */
export function classifyPaste(
  names: string[],
  rows: readonly Pick<ProfitBreakdown, "productName" | "roi">[],
  minRoi: number,
): PasteVerdictResult {
  const byName = new Map(rows.map((r) => [r.productName.toLowerCase(), r]));
  const worth: string[] = [];
  const skip: string[] = [];
  const notBuildable: string[] = [];
  for (const name of names) {
    const r = byName.get(name.toLowerCase());
    if (!r) notBuildable.push(name);
    else if (r.roi !== null && r.roi >= minRoi) worth.push(name);
    else skip.push(name);
  }
  return { worth, skip, notBuildable };
}
