import { invoke } from "@tauri-apps/api/core";

/** Aggregated jump distance over a Pochven system's C729 exit candidates. */
export interface PochvenStat {
  avg: number;
  median: number;
  min: number;
  max: number;
}
export interface PochvenHubRoutes {
  hub: string;
  shortest: PochvenStat;
  secure: PochvenStat;
  insecure: PochvenStat;
}
export interface PochvenRoute {
  system: string;
  /** Number of C729 exit candidates. */
  candidates: number;
  hubs: PochvenHubRoutes[];
}
export interface PochvenRoutes {
  hubs: string[];
  systems: PochvenRoute[];
}

/**
 * Per-Pochven-system jump distances to the trade hubs (secure/shortest/insecure;
 * avg/median/min/max over each system's C729 exit candidates), computed live
 * over the stargate graph. Cached ~24h. Public — no login needed.
 */
export function pochvenRoutes(): Promise<PochvenRoutes> {
  return invoke<PochvenRoutes>("pochven_routes");
}
