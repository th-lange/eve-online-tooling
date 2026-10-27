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
export interface TargetProductView {
  typeId: number;
  name: string;
}

export interface ColonyView {
  characterId: number;
  characterName: string;
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
  /** User-authored notes for this colony — local, not from ESI. */
  notes: string;
  /** PI products the user intends to build here, possibly across several
   * extraction/production cycles — local, not from ESI. */
  targetProducts: TargetProductView[];
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

export interface ColonyNoteView {
  characterId: number;
  planetId: number;
  notes: string;
  targetProducts: TargetProductView[];
}

/**
 * Save a colony's notes and target-product list. Local, not ESI — deleted
 * automatically once the colony itself no longer exists for that character.
 */
export function piColonyNoteSet(
  characterId: number,
  planetId: number,
  notes: string,
  targetProductTypeIds: number[],
): Promise<ColonyNoteView> {
  return invoke<ColonyNoteView>("pi_colony_note_set", {
    characterId,
    planetId,
    notes,
    targetProductTypeIds,
  });
}

// --- Production-chain planner (#882) ---

export interface ChainNode {
  typeId: number;
  name: string;
  /** 0 = a raw P0 resource, 1..4 = P1..P4. */
  tier: number;
  /** How much of this node the parent schematic consumes per cycle; 0 for
   * the root and for tier-0 (P0) leaves. */
  qtyPerCycle: number;
  /** Planet types that alone can supply this node's whole subtree; empty
   * means no single planet can — the colony needs imports. */
  planetTypes: string[];
  children: ChainNode[];
}

/**
 * The production-chain tree for a P1–P4 commodity: which planet type(s) can
 * produce it single-planet (no imports), and the full P0→target stage tree.
 */
export function piProductionChain(typeId: number): Promise<ChainNode> {
  return invoke<ChainNode>("pi_production_chain", { typeId });
}

/** One planet in a solar system, for the Planner's "where are you building
 * this" picker. */
export interface PlanetOption {
  id: number;
  name: string;
  /** The planet's own type (e.g. "Barren", "Gas"), same vocabulary as
   *  `ChainNode.planetTypes` — shown right in the picker so it can be
   *  matched against the chain's planet-type badges without leaving the
   *  dropdown. */
  planetType: string;
}

/**
 * A solar system's planets, for the Planner's "where are you building
 * this" picker — call once a system is chosen (via `systemSearch`), then
 * present the result as a small fixed list (a system has at most ~8
 * planets, no search needed).
 */
export function piPlanetsInSystem(systemId: number): Promise<PlanetOption[]> {
  return invoke<PlanetOption[]>("pi_planets_in_system", { systemId });
}

// --- Planner setups (#965) ---

/** One planned commodity in a saved setup: the commodity, its notes, and
 * the (optional) solar system/planet it's assigned to. */
export interface PlannerSetupItem {
  typeId: number;
  name: string;
  notes: string;
  systemId: number | null;
  systemName: string | null;
  planetId: number | null;
  planetName: string | null;
  /** Material type ids within this item's own production chain that are
   *  marked "produced on another planned colony, ship it in instead" —
   *  matched against another item's `typeId` in the same setup. */
  imports: number[];
  /** A user-chosen display name, overriding the default "System · Planet ·
   *  Product" label — `null` means "still using the auto-derived default",
   *  not "no name". */
  label: string | null;
}

/** A named, reusable Planner setup — the picked commodities (with notes and
 * system/planet assignments) saved for replay. */
export interface PlannerSetup {
  id: string;
  name: string;
  items: PlannerSetupItem[];
}

/** Every saved planner setup. */
export function piPlannerSetups(): Promise<PlannerSetup[]> {
  return invoke<PlannerSetup[]>("pi_planner_setups");
}

/** Save the current planner picks (with notes/system/planet) under a name,
 * returning the saved setup. */
export function piPlannerSetupSave(
  name: string,
  items: {
    typeId: number;
    notes?: string;
    systemId?: number | null;
    systemName?: string | null;
    planetId?: number | null;
    planetName?: string | null;
    imports?: number[];
    label?: string | null;
  }[],
): Promise<PlannerSetup> {
  return invoke<PlannerSetup>("pi_planner_setup_save", { name, items });
}

/** Delete a saved planner setup. */
export function piPlannerSetupDelete(id: string): Promise<void> {
  return invoke<void>("pi_planner_setup_delete", { id });
}

// --- Sync (#1128) ---
//
// The *raw* stored setups (unresolved — no SDE names), the sync payload for
// the `pi` module. See `lib/sync/stores.ts`.

/** The raw stored planner setups, serialized to JSON (`"[]"` when none). */
export function piPlannerSetupsExport(): Promise<string> {
  return invoke<string>("pi_planner_setups_export");
}

/** Overwrite the stored planner setups from JSON previously produced by
 *  `piPlannerSetupsExport`. */
export function piPlannerSetupsImport(content: string): Promise<void> {
  return invoke<void>("pi_planner_setups_import", { content });
}
