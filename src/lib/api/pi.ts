import { invoke } from "@tauri-apps/api/core";

// --- Planetary Interaction ---

export interface ExtractorView {
  productTypeId: number;
  product: string;
  qtyPerCycle: number;
  cycleTime: number;
  /** ISO time the current extraction program started (bar total = expiry − start). */
  installTime: string | null;
  /** ISO time the current extraction program ends (the restart timer). */
  expiryTime: string | null;
}
export interface ContentRow {
  typeId: number;
  name: string;
  amount: number;
  volume: number;
}
export interface StorageView {
  name: string;
  usedVolume: number;
  capacity: number;
  contents: ContentRow[];
}
export interface BalanceRow {
  typeId: number;
  name: string;
  producedPerHour: number;
  consumedPerHour: number;
  /** produced − consumed; negative = deficit. */
  net: number;
}
export interface ProducedItem {
  typeId: number;
  name: string;
  locked: boolean;
}
export interface ColonyView {
  planetId: number;
  systemId: number;
  systemName: string;
  planetType: string;
  upgradeLevel: number;
  pinCount: number;
  extractors: ExtractorView[];
  storage: StorageView[];
  balance: BalanceRow[];
  produced: ProducedItem[];
  needsAttention: boolean;
}

/**
 * The character's planetary colonies: extraction/production, extractor restart
 * timers, storage usage, and the required-vs-available balance. Requires
 * `esi-planets.manage_planets.v1` (re-login if just enabled).
 */
export function piOverview(): Promise<ColonyView[]> {
  return invoke<ColonyView[]>("pi_overview");
}
/**
 * Set autopilot to the colony's system in-game. ESI's "open info window"
 * endpoint only accepts character/corporation/alliance ids — it can't open a
 * planet or system window — so this routes you there instead.
 * Requires `esi-ui.write_waypoint.v1`.
 */
export function piShowInGame(systemId: number): Promise<void> {
  return invoke<void>("pi_show_in_game", { systemId });
}
/** Type ids locked in as "produced by PI". */
export function piLockedGet(): Promise<number[]> {
  return invoke<number[]>("pi_locked_get");
}
/** Replace the locked-in produced type ids. */
export function piLockedSet(typeIds: number[]): Promise<void> {
  return invoke<void>("pi_locked_set", { typeIds });
}
