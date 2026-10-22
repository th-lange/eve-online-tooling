import type { MatchedBlueprint } from "../../lib/api";

/** Priority order a tier group renders in — standard tech levels first
 *  (matching how players think about a mixed doctrine paste), then
 *  everything else (Faction/Officer/Deadspace) alphabetically. */
export const TIER_PRIORITY: Record<string, number> = {
  "Tech I": 0,
  "Tech II": 1,
};

/** Buckets matched blueprints by their SDE meta-group tier (e.g. "all T1
 *  base items into one group") — mirrors the materials-side grouping below,
 *  applied to the input blueprint list instead of the output materials. */
export function groupByTier(
  blueprints: MatchedBlueprint[],
): { tier: string; items: MatchedBlueprint[] }[] {
  const byTier = new Map<string, MatchedBlueprint[]>();
  for (const b of blueprints) {
    const existing = byTier.get(b.tier);
    if (existing) existing.push(b);
    else byTier.set(b.tier, [b]);
  }
  return [...byTier.entries()]
    .map(([tier, items]) => ({ tier, items }))
    .sort((a, b) => {
      const pa = TIER_PRIORITY[a.tier] ?? 2;
      const pb = TIER_PRIORITY[b.tier] ?? 2;
      return pa !== pb ? pa - pb : a.tier.localeCompare(b.tier);
    });
}
