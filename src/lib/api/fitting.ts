import { invoke } from "@tauri-apps/api/core";
import type { IdName } from "./common";

/** Slot + fitting cost of a candidate module (for fit-aware ranking). */
export interface ModuleInfo {
  id: number;
  slot: SlotKind;
  cpu: number;
  powergrid: number;
  calibration: number;
}

/** Slot + skill-adjusted CPU/PG/calibration for each candidate type, resolved on
 *  a hull at the chosen skills (the same resolution fitted modules get). */
export function fittingModuleInfo(
  shipTypeId: number,
  skillSource: SkillSource,
  typeIds: number[],
): Promise<ModuleInfo[]> {
  return invoke<ModuleInfo[]>("fitting_module_info", {
    shipTypeId,
    skillSource,
    typeIds,
  });
}

// --- Fitting ---

/** Where a fitted item sits on the hull. */
export type SlotKind =
  | "high"
  | "mid"
  | "low"
  | "rig"
  | "subsystem"
  | "drone"
  | "implant"
  | "booster"
  | "cargo"
  | "mode";

/** A module's activation state. */
export type ModuleState = "offline" | "online" | "active" | "overheated";

/** One fitted item: a module/rig/drone slot entry, optionally with a charge. */
export interface FitItem {
  typeId: number;
  slot: SlotKind;
  index: number;
  state: ModuleState;
  chargeTypeId?: number | null;
  quantity: number;
  /** How many of this drone stack are active (deployed), 0..=quantity. `null`
   * means "not yet customized" — defaults to as many as bandwidth/the 5-in-
   * space limit allow. Only meaningful for `slot === "drone"`. */
  activeDrones?: number | null;
}

/** The editable fit document. */
export interface Fit {
  id: string;
  name: string;
  shipTypeId: number;
  items: FitItem[];
  /** Modules projected onto this fit (webs/paints/…) — incoming effects (#178). */
  projected?: FitItem[];
}

/** A hull's slot layout + fitting resources, for the empty editor. */
export interface ShipLayout {
  typeId: number;
  name: string;
  groupName: string;
  highSlots: number;
  midSlots: number;
  lowSlots: number;
  rigSlots: number;
  subsystemSlots: number;
  /** Tactical Destroyer mode slot: 1 for a T3D hull, 0 otherwise. */
  modeSlots: number;
  turretHardpoints: number;
  launcherHardpoints: number;
  cpuOutput: number;
  powergridOutput: number;
  calibration: number;
  droneBay: number;
  droneBandwidth: number;
}

/** Fitting-resource usage vs the hull's output. */
export interface ResourceUsage {
  cpuUsed: number;
  cpuOutput: number;
  powergridUsed: number;
  powergridOutput: number;
  calibrationUsed: number;
  calibrationOutput: number;
}

/** A validation finding (over-CPU, too many turrets, …). */
export interface FitProblem {
  severity: "error" | "warning";
  message: string;
  itemIndex?: number | null;
}

/** Capacitor stability, computed from finalized (all-V) attributes. */
export interface CapStats {
  capacity: number;
  rechargeSeconds: number;
  peakRecharge: number;
  drain: number;
  stable: boolean;
  stablePct?: number | null;
  /** Seconds until empty when not stable; `null`/absent when stable. */
  depletionSeconds?: number | null;
  /** Sampled cap level over time as `[seconds, percent]` from full (for the chart). */
  trajectory: [number, number][];
}

/** One category of EW projected onto the fit (presence only, no magnitude). */
export interface EwTag {
  /** `web` | `paint` | `damp` | `weaponDisruption` | `ecm` | `neut` | `nos`. */
  category: string;
  label: string;
  count: number;
  /** True for web/paint/damp — their magnitude is already in the stats. */
  modeled: boolean;
  /** True for ECM — shown as an opt-in "jammed" scenario. */
  jam: boolean;
}

/** Tank: HP, resists, EHP and local reps. Resist arrays are
 * `[em, thermal, kinetic, explosive]` fractions (0–1). */
export interface TankStats {
  shieldHp: number;
  armorHp: number;
  hullHp: number;
  ehp: number;
  shieldResists: [number, number, number, number];
  armorResists: [number, number, number, number];
  hullResists: [number, number, number, number];
  /** Active local reps/s (shield boosters / armor repairers). */
  shieldRepS: number;
  armorRepS: number;
  /** Peak passive shield regen (HP/s). */
  passiveShieldS: number;
}

/** Full-application DPS by weapon kind. */
export interface DpsBreakdown {
  turret: number;
  missile: number;
  drone: number;
  total: number;
}

/** Engagement range of one fitted weapon/mining module, after skills + ammo. */
export interface WeaponRange {
  typeId: number;
  chargeTypeId?: number | null;
  /** Optimal (m); for missiles this is the flight range, for mining its reach. */
  optimal: number;
  falloff: number;
}

/** A fleet boost module + optional charge projected onto this fit (#705) —
 *  a command-burst/fleet-link module the user is "receiving" from a fleet
 *  member. */
export interface FleetBoost {
  moduleTypeId: number;
  chargeTypeId?: number;
}

/** Target profile for applied-DPS calculation. `speed` feeds the missile
 *  explosion-velocity comparison; `angularVelocity` (rad/s) drives turret/
 *  drone tracking loss directly, independent of range — falloff and missile
 *  range gating come from the DPS-vs-range curve, which sweeps distance.
 *  `dronesKeepPace`: drones at/above the target's speed assume perfect
 *  application instead of the tracking formula (PYFA's "auto" drone mode).
 *  `missilesNeedOvertake`: missiles slower than the target's speed never
 *  connect at all — not modeled by PYFA, off by default to match it. */
export interface TargetProfile {
  sigRadius: number;
  speed: number;
  angularVelocity: number;
  dronesKeepPace: boolean;
  missilesNeedOvertake: boolean;
}

/** Navigation: speed, agility, align and signature. */
export interface NavStats {
  maxVelocity: number;
  alignTime: number;
  agility: number;
  signatureRadius: number;
}

/** Targeting: locks, range, scan resolution and sensor strength
 * `[radar, ladar, magnetometric, gravimetric]`. */
export interface TargetStats {
  maxTargets: number;
  lockRange: number;
  scanResolution: number;
  sensorStrength: [number, number, number, number];
}

/** Computed result of simulating a fit (resources + validation + dogma stats). */
export interface FitStats {
  resources: ResourceUsage;
  validation: FitProblem[];
  capacitor?: CapStats | null;
  tank?: TankStats | null;
  dps?: DpsBreakdown | null;
  navigation?: NavStats | null;
  /** Resolved slot layout (T3 subsystems grant slots). */
  layout?: ShipLayout | null;
  targeting?: TargetStats | null;
  price?: number | null;
  /** Per-weapon engagement ranges (turrets/missiles/mining). */
  weaponRanges?: WeaponRange[];
  /** Type ids of fitted modules that can be activated (rest are passive). */
  activatableTypes?: number[];
  /** EW projected onto this fit, by category (presence only). */
  projectedEw?: EwTag[];
  /** Authoritative active (deployed) count per fitted item, parallel to
   * `Fit.items` by index — `null` for non-drone items. */
  droneActive?: Array<number | null>;
  /** How many of each fitted drone stack could ever be active on this hull
   * (bandwidth cap), parallel to `Fit.items` — `null` for non-drone items.
   * The star-count display cap: some hulls only support a couple of a
   * bandwidth-hungry drone type even though the 5-in-space limit allows more. */
  droneMaxActive?: Array<number | null>;
  /** Applied DPS against the supplied target profile; absent when no
   * target profile was given. */
  appliedDps?: DpsBreakdown;
  /** DPS-over-range curve as `[distance_m, dps]` pairs; empty when no
   * target profile was given. */
  dpsRangeCurve?: [number, number][];
}

/** One priced line of a whole-fit valuation. */
export interface FitPriceLine {
  typeId: number;
  name: string;
  quantity: number;
  buyUnit?: number | null;
  sellUnit?: number | null;
}

/** Whole-fit market valuation. */
export interface FitPrice {
  buyTotal: number;
  sellTotal: number;
  lines: FitPriceLine[];
}

/** A hull's slot layout + fitting resources; `null` if it isn't a known ship. */
export function fittingShipLayout(
  shipTypeId: number,
): Promise<ShipLayout | null> {
  return invoke<ShipLayout | null>("fitting_ship_layout", {
    typeId: shipTypeId,
  });
}

/** Parse an EFT clipboard string into a resolved fit. */
export function fittingImportEft(text: string): Promise<Fit> {
  return invoke<Fit>("fitting_import_eft", { text });
}

/**
 * Add a module/drone to a fit. The backend classifies the type's slot from its
 * dogma effects and places it at the next free index in that slot.
 */
export function fittingAddItem(
  fit: Fit,
  typeId: number,
  chargeTypeId: number | null = null,
): Promise<Fit> {
  return invoke<Fit>("fitting_add_item", { fit, typeId, chargeTypeId });
}

/** Charges loadable into a weapon/module (right group + size + capacity). Empty
 *  when it takes no charge — drives the per-weapon ammo picker. */
export function fittingCompatibleCharges(typeId: number): Promise<IdName[]> {
  return invoke<IdName[]>("fitting_compatible_charges", { typeId });
}

/** Wormhole-class ("Class N \<effect\> Effects") and Pochven metaliminal-storm
 *  ("Weak/Strong Metaliminal \<weather\> Storm") environment beacons a fit can
 *  be sitting in — drives the environment selector (#env-selector). Not
 *  Abyssal Deadspace weather (that's a per-filament-pocket mechanic with no
 *  static SDE data — see [`AbyssalWeatherSelection`], a separate, hardcoded
 *  path). */
export function fittingEnvironmentEffects(): Promise<IdName[]> {
  return invoke<IdName[]>("fitting_environment_effects");
}

/** Which Abyssal Deadspace weather a fit is sitting in. Hardcoded from
 *  community reference data — Abyssal weather has no dogma-attribute
 *  representation in the SDE at all (unlike Pochven metaliminal storms,
 *  which are dogma-driven via [`fittingEnvironmentEffects`]). Each weather's
 *  bonus is a flat 50% regardless of tier; only the resist penalty scales:
 *
 *  | Weather | Penalty | Bonus |
 *  |---|---|---|
 *  | Dark | −tier% turret optimal + falloff | +50% max velocity |
 *  | Electrical | −tier% EM resist | −50% cap recharge time |
 *  | Exotic | −tier% kinetic resist | +50% scan resolution |
 *  | Firestorm | −tier% thermal resist | +50% armor HP |
 *  | Gamma | −tier% explosive resist | +50% shield HP | */
export type AbyssalWeather =
  "dark" | "electrical" | "exotic" | "firestorm" | "gamma";

export interface AbyssalWeatherSelection {
  weather: AbyssalWeather;
  /** Penalty magnitude (%) — 30/50/70 per filament tier. */
  tierPct: number;
}

/** Serialize a fit to an EFT clipboard string. */
export function fittingExportEft(fit: Fit): Promise<string> {
  return invoke<string>("fitting_export_eft", { fit });
}

/** Skills basis for simulation: best-case all-V, or the logged-in character. */
export type SkillSource = "allFive" | "character";

/** Simulate a fit: validation + dogma stats at the chosen skill basis.
 *  `fleetBoosts` (#705) are command-burst/fleet-link modules the fit is
 *  "receiving" from a fleet member. `environmentEffect` is a wormhole-class
 *  or Pochven-metaliminal-storm environment beacon type id the fit is
 *  sitting in. `abyssalWeather` is the separate, mutually exclusive Abyssal
 *  Deadspace weather choice. */
export function fittingSimulate(
  fit: Fit,
  skillSource: SkillSource = "allFive",
  damageProfile?: [number, number, number, number],
  neutGjs?: number,
  targetProfile?: TargetProfile,
  fleetBoosts?: FleetBoost[],
  environmentEffect?: number | null,
  abyssalWeather?: AbyssalWeatherSelection | null,
): Promise<FitStats> {
  return invoke<FitStats>("fitting_simulate", {
    fit,
    skillSource,
    damageProfile: damageProfile ?? null,
    neutGjs: neutGjs ?? null,
    targetProfile: targetProfile ?? null,
    fleetBoosts: fleetBoosts
      ? fleetBoosts.map((b) => [b.moduleTypeId, b.chargeTypeId ?? -1])
      : null,
    environmentEffect: environmentEffect ?? null,
    abyssalWeather: abyssalWeather ?? null,
  });
}

/** Price a whole fit at a market. */
export function fittingPrice(
  fit: Fit,
  regionId: number,
  stationId?: number | null,
): Promise<FitPrice> {
  return invoke<FitPrice>("fitting_price", { fit, regionId, stationId });
}

/** What the optimizer maximizes when filling empty slots. */
export type OptimizeObjective = "tank" | "damage" | "repair" | "yield";

/** Optimizer slot scope: rework every relevant slot, or fill only empty ones. */
export type OptimizeMode = "all" | "empty";

/** Optional hard constraints the optimizer keeps the result within. */
export interface OptimizeConstraints {
  /** Require the result to be capacitor-stable. */
  capStable?: boolean;
  /** Cap total fit ISK cost; needs a region for pricing. */
  maxCost?: number | null;
  /** Region the budget is priced in (defaults to The Forge / Jita). */
  regionId?: number;
  stationId?: number | null;
}

/** Result of an optimize pass: the reworked fit plus whether it met the requested
 * hard constraints. */
export interface OptimizeResult {
  fit: Fit;
  capStable: boolean;
  withinBudget: boolean;
}

/** Rework a fit's objective-relevant slots for the best build, drawn from the
 * allowed meta groups (metaGroupIDs; e.g. [1,2] = Tech I + Tech II), optionally
 * kept capacitor-stable and/or within an ISK budget. Returns the optimized fit and
 * whether each constraint was met. */
export function fittingOptimize(
  fit: Fit,
  objective: OptimizeObjective,
  metaGroups: number[],
  mode: OptimizeMode = "all",
  constraints: OptimizeConstraints = {},
): Promise<OptimizeResult> {
  return invoke<OptimizeResult>("fitting_optimize", {
    fit,
    objective,
    metaGroups,
    mode,
    capStable: constraints.capStable ?? false,
    maxCost: constraints.maxCost ?? null,
    regionId: constraints.regionId ?? null,
    stationId: constraints.stationId ?? null,
  });
}

/** Save (insert or update) a fit locally; returns its id. */
export function fittingSaveLocal(fit: Fit): Promise<string> {
  return invoke<string>("fitting_save_local", { fit });
}

/** All locally saved fits. */
export function fittingListLocal(): Promise<Fit[]> {
  return invoke<Fit[]>("fitting_list_local");
}

/** The active character's (and corp's) in-game saved fittings from ESI. Empty
 * if the `esi-fittings` scope isn't granted (enable it on the EVE app + re-login). */
export function fittingEsiList(force = false): Promise<Fit[]> {
  return invoke<Fit[]>("fitting_esi_list", { force });
}

/** Save a fit to the active character's in-game fittings (needs the
 * `esi-fittings.write_fittings.v1` scope). Returns the new fitting id. */
export function fittingEsiPush(fit: Fit): Promise<number> {
  return invoke<number>("fitting_esi_push", { fit });
}

/** Delete a locally saved fit by id. */
export function fittingDeleteLocal(id: string): Promise<void> {
  return invoke<void>("fitting_delete_local", { id });
}
