/**
 * Ship combat archetype classification from weapon engagement range.
 *
 * Effective range = optimal + falloff/2 (turrets).
 * Missiles have falloff = 0, so effective range = flight range.
 * The highest effective range across DPS weapons defines the archetype.
 *
 * Bands (in metres):
 *   Brawler      < 5 000 m
 *   Scram kiter  5 000 – 10 000 m
 *   Web kiter   10 000 – 13 000 m
 *   Kiter       16 000 – 28 000 m
 *
 * Gaps (13–16 km, >28 km) and fits with no DPS weapons return null.
 */

export type Archetype = "brawler" | "scramkiter" | "webkiter" | "kiter";

export interface ArchetypeWeapon {
  optimal: number;
  falloff: number;
  /** Turret tracking (rad/s); 0 or absent for missiles and non-weapon modules
   *  (neuts, webs, damps, remote reps). Used to filter to DPS weapons only. */
  tracking?: number;
}

/**
 * Classify a fit's archetype from its weapon lines. Returns null when no
 * turret weapons are present or the range falls outside a defined band.
 *
 * Only turrets (tracking > 0 AND falloff > 0) are considered. Missiles have
 * no falloff (flight range only), so `optimal + falloff/2` is meaningless for
 * them. Neuts, webs, and damps are excluded by the tracking check.
 */
export function classifyArchetype(
  weapons: ArchetypeWeapon[],
): Archetype | null {
  const dps = weapons.filter(
    (w) => (w.tracking ?? 0) > 0 && w.falloff > 0,
  );
  if (dps.length === 0) return null;
  const maxRange = Math.max(...dps.map((w) => w.optimal + w.falloff / 2));
  if (maxRange < 5_000) return "brawler";
  if (maxRange < 10_000) return "scramkiter";
  if (maxRange < 13_000) return "webkiter";
  if (maxRange >= 16_000 && maxRange <= 28_000) return "kiter";
  return null;
}

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  brawler: "Brawler",
  scramkiter: "Scram kiter",
  webkiter: "Web kiter",
  kiter: "Kiter",
};

/** Tailwind chip classes (bg + text) per archetype. */
export const ARCHETYPE_CLASS: Record<Archetype, string> = {
  brawler: "bg-red-900/50 text-red-300",
  scramkiter: "bg-amber-900/50 text-amber-300",
  webkiter: "bg-sky-900/50 text-sky-300",
  kiter: "bg-emerald-900/50 text-emerald-300",
};
