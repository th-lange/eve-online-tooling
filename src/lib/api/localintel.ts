import { invoke } from "@tauri-apps/api/core";

export interface LocalPilot {
  characterId: number;
  name: string;
  corporationId: number;
  corporation: string;
  allianceId: number | null;
  alliance: string | null;
  /** Your standing toward corp/alliance/faction (most specific), or null. */
  standing: number | null;
  /** "blue" | "neutral" | "red". */
  threat: string;
}

export interface LocalScanResult {
  pilots: LocalPilot[];
  reds: number;
  neutrals: number;
  blues: number;
  /** Pasted names that didn't resolve to a character. */
  unresolved: string[];
}

/**
 * Classify a pasted in-game Local member list (one name per line) by
 * corp/alliance and your standing. Resolves via public ESI; standings use the
 * logged-in character.
 */
export function localScan(text: string): Promise<LocalScanResult> {
  return invoke<LocalScanResult>("localintel_scan", { text });
}

export interface LocalLogResult {
  /** Pilots who spoke in the newest Local log (logs don't carry the member list). */
  senders: string[];
  file: string;
}

/** Speaker names from the newest `Local_*` chatlog in a user-configured folder. */
export function localLogNames(logsDir: string): Promise<LocalLogResult> {
  return invoke<LocalLogResult>("localintel_log_names", { logsDir });
}

export interface ZkillStats {
  characterId: number;
  /** 0–100: share of recent engagements that were kills. */
  dangerRatio: number;
  /** 0–100: share of kills made in a gang. */
  gangRatio: number;
  shipsDestroyed: number;
  shipsLost: number;
  active: boolean;
}

/**
 * zKillboard danger stats for the given characters (per-character cached ~6h).
 * Best-effort: characters that fail to fetch are simply absent.
 */
export function localintelZkill(characterIds: number[]): Promise<ZkillStats[]> {
  return invoke<ZkillStats[]>("localintel_zkill", { characterIds });
}

export interface WatchEntry {
  id: number;
  name: string;
}

/** Watched corps/alliances (a scan flags any pilot in them). */
export function localintelGetWatchlist(): Promise<WatchEntry[]> {
  return invoke<WatchEntry[]>("localintel_get_watchlist");
}

/** Add/remove a corp or alliance from the watchlist; returns the updated list. */
export function localintelSetWatchlist(
  id: number,
  name: string,
  add: boolean,
): Promise<WatchEntry[]> {
  return invoke<WatchEntry[]>("localintel_set_watchlist", { id, name, add });
}
