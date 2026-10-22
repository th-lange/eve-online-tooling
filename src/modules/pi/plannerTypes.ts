// Planner-tab types + pure helpers — kept out of the component files so
// react-refresh hot-reloads them cleanly (same convention as `balance.ts`).

/** One commodity planned on the Planner tab: the pick itself, free-text
 * notes, and the (optional) solar system/planet it's assigned to build on.
 * Persisted as-is (see `picks` below) and is exactly the shape a setup is
 * saved/loaded as (#965). */
export interface PlannerPick {
  id: number;
  name: string;
  notes: string;
  systemId: number | null;
  systemName: string | null;
  planetId: number | null;
  planetName: string | null;
  /** Material type ids within this pick's own production chain that are
   *  marked "produced on another planned colony, ship it in instead" —
   *  matched against another pick's `id` in the same plan. Toggled from
   *  the consuming side (the chain node for the imported material), not
   *  the producing pick. */
  imports: number[];
  /** A user-chosen display name, overriding the default "System · Planet ·
   *  Product" label below — `null` means "still using the auto-derived
   *  default", not "no name". */
  label: string | null;
}

/** Display label for a pick — the user's own override if set, else a live
 *  "System · Planet · Product" default built from whatever's picked so far
 *  (just the product name if neither system nor planet is assigned yet).
 *  Used both on the pick's own card and whenever another pick refers to it
 *  (an "Import from …" / "Exported to …" hint). */
export function pickLabel(p: PlannerPick): string {
  const auto = [p.systemName, p.planetName, p.name].filter(Boolean).join(" · ");
  return p.label ?? auto;
}

/** Badge color by PI tier — a quick-scan cue for how deep in the chain a
 * material sits, independent of which specific planet types it lists (the
 * tier number itself is already shown as text next to the material's name,
 * so this is reinforcement, not the only signal, per #848). */
export const TIER_BADGE_CLASS: Record<number, string> = {
  0: "bg-zinc-800 text-zinc-300",
  1: "bg-sky-900/40 text-sky-300",
  2: "bg-emerald-900/40 text-emerald-300",
  3: "bg-yellow-900/40 text-yellow-300",
  4: "bg-violet-900/40 text-violet-300",
};
