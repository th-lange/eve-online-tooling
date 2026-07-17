import { invoke } from "@tauri-apps/api/core";

export interface SystemActivity {
  systemId: number;
  name: string;
  region: string;
  /** Raw SDE security status (−1.0 … 1.0). */
  security: number;
  jumps: number;
  shipKills: number;
  podKills: number;
  npcKills: number;
}

/**
 * Per-system jumps + ship/pod/npc kills over the last hour (CCP hourly
 * aggregates, k-space only). Cached ~30 min; `refresh` bypasses the cache.
 */
export function systemActivity(refresh = false): Promise<SystemActivity[]> {
  return invoke<SystemActivity[]>("route_system_activity", { refresh });
}

export interface SystemMatch {
  id: number;
  name: string;
}

/** A neighbourhood node — a system's activity plus its distance (jumps) from the centre. */
export interface NeighbourNode extends SystemActivity {
  /** Jumps from the centre (0 = the centre itself). */
  distance: number;
}

export interface Neighbourhood {
  center: number;
  nodes: NeighbourNode[];
  /** Stargate edges between systems in the neighbourhood. */
  edges: [number, number][];
}

/** Search solar systems by name (for the neighbourhood picker). */
export function systemSearch(query: string): Promise<SystemMatch[]> {
  return invoke<SystemMatch[]>("route_system_search", { query });
}

export interface BreadcrumbEntry {
  systemId: number;
  name: string;
  security: number;
  region: string;
  /** True for a wormhole (J-space) system. */
  wspace: boolean;
  enteredAt: number;
  /** Gate jumps from the previous trail entry: 1 = direct gate, >1 = systems
   *  skipped between polls, -1 = no gate path (wormhole/filament/clone),
   *  0 = unknown (trail start or legacy entry). */
  gapJumps: number;
}

/**
 * Poll the character's current system and append it to the travel trail.
 * Requires `esi-location.read_location.v1` (re-login if added). Call on an
 * interval while the Route view is open — there's no travel-history API.
 */
export function routeLocation(): Promise<BreadcrumbEntry[]> {
  return invoke<BreadcrumbEntry[]>("route_location");
}
/** The stored travel trail without polling ESI. */
export function routeBreadcrumb(): Promise<BreadcrumbEntry[]> {
  return invoke<BreadcrumbEntry[]>("route_breadcrumb");
}
/** Clear the travel trail. */
export function routeClearBreadcrumb(): Promise<void> {
  return invoke<void>("route_clear_breadcrumb");
}

export interface NearestWormhole {
  found: boolean;
  /** Constraint note / hint when nothing usable was found. */
  message: string | null;
  /** True when you're in w-space (uses the mapped-chain fallback). */
  inWspace: boolean;
  currentSystemId: number;
  currentName: string;
  /** System to travel to — the WH entrance (k-space) or chain exit (w-space). */
  entranceSystemId: number;
  entranceName: string;
  jumps: number;
  whType: string | null;
  maxShipSize: string | null;
  /** System the hole leads into (Thera/Turnur for a public entrance). */
  intoSystemId: number | null;
  intoName: string | null;
  expiresInHours: number | null;
}

/**
 * Nearest known public wormhole entrance (EVE-Scout Thera/Turnur) reachable by
 * stargate from your last-recorded system; in w-space, the nearest scanned exit
 * over your mapped chain. Reads the travel breadcrumb — call "My location" first.
 * ESI can't reveal un-scanned signatures, so this points at *known* holes only.
 */
export function routeNearestWormhole(): Promise<NearestWormhole> {
  return invoke<NearestWormhole>("route_nearest_wormhole");
}

/** Stargate neighbourhood around a system out to `depth` jumps, with jumps/kills heat. */
export function systemNeighbourhood(
  systemId: number,
  depth: number,
): Promise<Neighbourhood> {
  return invoke<Neighbourhood>("route_system_neighbourhood", { systemId, depth });
}
