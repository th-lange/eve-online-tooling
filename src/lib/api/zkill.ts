import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// --- Shared zKillboard live kill-stream (#924) ---

/** One live kill event from the shared background stream — mirrors Rust's
 *  `zkill::live::KillEvent`. Deliberately lean: no ship info or entity
 *  names, just enough to place a kill in time, space, faction, and corp/
 *  alliance terms. */
export interface KillEvent {
  killmailId: number;
  solarSystemId: number;
  /** Unix epoch seconds. */
  timeSecs: number;
  victimFactionId: number | null;
  attackerFactionIds: number[];
  victimCorporationId: number | null;
  victimAllianceId: number | null;
  /** Deduped; only attackers that have one (NPC/structure attackers don't). */
  attackerCorporationIds: number[];
  attackerAllianceIds: number[];
}

/** Subscribe to live kills as the shared background stream observes them. */
export function onZkillKill(
  handler: (event: KillEvent) => void,
): Promise<UnlistenFn> {
  return listen<KillEvent>("zkill://kill", (event) => handler(event.payload));
}

/** Take a lease on the shared killstream (#1060): the backend websocket only
 *  runs while at least one lease is held. Pair with
 *  `zkillStreamUnsubscribe` on unmount — `useZkillStreamLease` does both. */
export function zkillStreamSubscribe(): Promise<void> {
  return invoke<void>("zkill_stream_subscribe");
}

/** Release a killstream lease (floored at zero backend-side). */
export function zkillStreamUnsubscribe(): Promise<void> {
  return invoke<void>("zkill_stream_unsubscribe");
}

export interface ZkillStreamStatus {
  connected: boolean;
  eventCount: number;
  windowSecs: number;
}

/** Connectivity + retained-index size for the live stream — a status
 *  indicator or debugging aid, not the per-system/per-faction breakdown
 *  (see `zkillStreamSystemCounts`/`zkillStreamFactionCounts`). */
export function zkillStreamStatus(): Promise<ZkillStreamStatus> {
  return invoke<ZkillStreamStatus>("zkill_stream_status");
}

/** Live kill counts per solar system across the retained window (keyed by
 *  `String(systemId)`), universe-wide — no faction filter. */
export function zkillStreamSystemCounts(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("zkill_stream_system_counts");
}

export interface ZkillStreamFactionCounts {
  kills: number;
  losses: number;
}

/** Live `(kills-as-attacker, losses-as-victim)` for one faction across the
 *  retained window. */
export function zkillStreamFactionCounts(
  factionId: number,
): Promise<ZkillStreamFactionCounts> {
  return invoke<ZkillStreamFactionCounts>("zkill_stream_faction_counts", {
    factionId,
  });
}
