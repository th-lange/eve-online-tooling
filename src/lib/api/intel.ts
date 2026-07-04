import { invoke } from "@tauri-apps/api/core";

/** One active Sansha incursion. */
export interface IncursionRow {
  staging: string;
  constellation: string;
  faction: string;
  /** Remaining influence, 0 (about to end) … 1 (freshly spawned). */
  influence: number;
  /** The mothership has spawned — final stage, best payouts. */
  hasBoss: boolean;
  /** "established" | "mobilizing" | "withdrawing". */
  state: string;
  /** Infested systems in the constellation. */
  systems: number;
}

/** Active incursions, most-contested first. Public data, cached ~5 min. */
export function intelIncursions(): Promise<IncursionRow[]> {
  return invoke<IncursionRow[]>("intel_incursions");
}

/** One militia's faction-warfare standing. */
export interface FwRow {
  faction: string;
  /** "Caldari–Gallente" | "Amarr–Minmatar". */
  warzone: string;
  pilots: number;
  systemsControlled: number;
  killsYesterday: number;
  killsLastWeek: number;
  vpYesterday: number;
  vpLastWeek: number;
}

/** Faction-warfare militia stats, most systems held first. Public, cached ~10 min. */
export function intelFwStats(): Promise<FwRow[]> {
  return invoke<FwRow[]>("intel_fw_stats");
}
