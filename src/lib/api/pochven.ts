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
  /** Security status of the candidate system. */
  security: number;
  /** Ship + pod kills in the last hour (ESI hourly aggregate). */
  kills: number;
  /** Jumps from the searcher's current system. */
  jumps: number;
  /** Scan order (1-based): depth-first visit order of the minimal-jump
   *  (Steiner-tree) network through the candidates. */
  order: number;
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
  /** Scan order (1-based) for candidates; 0 for travel/origin. */
  order: number;
  leadsTo: string[];
}
export interface PochvenMap {
  nodes: PochvenMapNode[];
  edges: [number, number][];
}
export interface EntrySearch {
  from: string;
  /** Max jump distance the candidates were filtered to. */
  maxJumps: number;
  /** Pochven systems reachable via the in-range candidates. */
  targets: string[];
  /** Jump path (system names) to the first scan target. */
  route: string[];
  /** Candidate exit systems, in scan order. */
  candidates: EntryCandidate[];
  /** Scan map: candidates + the grey travel systems linking them. */
  map: PochvenMap;
}

/**
 * From `systemId`, find every C729 entry candidate within `maxJumps`, order
 * them by a minimal-jump visiting sequence (depth-first over a Dreyfus–Wagner
 * Steiner tree), and list the reachable Pochven target systems.
 */
export function pochvenSearch(
  systemId: number,
  maxJumps: number,
): Promise<EntrySearch> {
  return invoke<EntrySearch>("pochven_search", { systemId, maxJumps });
}

/** A k-space system a 'Extraction' filament can reach from a Pochven system. */
export interface ExitTarget {
  name: string;
  security: number;
  region: string;
  lightYears: number;
}

/** C729 entry-candidate counts per security band for one Pochven system. */
export interface EntryBands {
  hisec: number;
  lowsec: number;
  nullsec: number;
}

/** A k-space region a system's C729 can spawn in, with its candidate count. */
export interface SpawnRegion {
  region: string;
  count: number;
}

/** One Pochven system on the reference map, at its true galactic position. */
export interface PochvenMapSystem {
  systemId: number;
  name: string;
  security: number;
  /** Galactic map-plane coordinates (x, z) — the plane dotlan plots. */
  x: number;
  y: number;
  /** K-space systems within 2.5 ly — where a Proximity 'Extraction' filament
   *  activated here can drop you (nearest first). */
  exits: ExitTarget[];
  /** Entry-candidate counts per security band (from the backend dataset). */
  bands: EntryBands;
  /** Candidate counts per k-space spawn region, descending by count. */
  spawnRegions: SpawnRegion[];
}
export interface PochvenTopology {
  systems: PochvenMapSystem[];
  edges: [number, number][];
}

/**
 * The real Pochven map: the 27 systems at their true galactic positions plus
 * the actual internal stargate links, from the SDE (matches the in-game map).
 */
export function pochvenMap(): Promise<PochvenTopology> {
  return invoke<PochvenTopology>("pochven_map");
}
