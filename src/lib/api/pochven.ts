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

/** A C729 entry candidate near the searcher. */
export interface EntryCandidate {
  system: string;
  region: string;
  /** Jumps from the searcher's current system. */
  jumps: number;
  /** Pochven system(s) this candidate's C729 leads into. */
  leadsTo: string[];
}
/** A node in the entry-scan map. */
export interface PochvenMapNode {
  systemId: number;
  name: string;
  /** "origin" | "travel" | hisec | lowsec | nullsec. */
  kind: string;
  candidate: boolean;
  origin: boolean;
  jumps: number;
  leadsTo: string[];
}
export interface PochvenMap {
  nodes: PochvenMapNode[];
  edges: [number, number][];
}
export interface EntrySearch {
  from: string;
  /** Jump path (system names) to the nearest candidate. */
  route: string[];
  /** Candidate exit systems, nearest first. */
  candidates: EntryCandidate[];
  /** Scan map: candidates + the grey travel systems linking them. */
  map: PochvenMap;
}

/**
 * From `systemId`, route to the nearest C729 entry candidate and list the
 * closest candidates (nearest first) to jump to and scan.
 */
export function pochvenSearch(systemId: number): Promise<EntrySearch> {
  return invoke<EntrySearch>("pochven_search", { systemId });
}
