import type { WormholeType } from "../../lib/api";

/** Look up a wormhole type by its signature code, case-insensitively (e.g. the
 * "N766"/"K162" a user types into a connection's sig field). Pure. */
export function whTypeByCode(
  code: string,
  types: WormholeType[],
): WormholeType | undefined {
  const c = code.trim().toUpperCase();
  if (!c) return undefined;
  return types.find((t) => t.code.toUpperCase() === c);
}

/** Largest hull class a hole admits, from its max jump mass (kg). Buckets are
 * approximate — the exact hull list per threshold varies — but good enough to
 * label "what fits". Pure. */
export function maxShipLabel(maxJumpMassKg: number | null): string {
  if (maxJumpMassKg == null || maxJumpMassKg <= 0) return "unknown";
  if (maxJumpMassKg <= 5_000_000) return "frigate";
  if (maxJumpMassKg <= 62_000_000) return "cruiser";
  if (maxJumpMassKg <= 375_000_000) return "battleship";
  if (maxJumpMassKg <= 1_000_000_000) return "freighter";
  return "capital";
}
