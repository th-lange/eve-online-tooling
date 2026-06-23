// Typed wrappers around Tauri `invoke`. Every Rust command the frontend calls
// is exposed here so components depend on a small typed surface rather than raw
// string command names.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Health-check the Rust bridge. Returns `"pong"`. */
export function ping(): Promise<string> {
  return invoke<string>("ping");
}

// --- Auth (EVE SSO, multi-character) ---

export interface Character {
  characterId: number;
  name: string;
  scopes: string[];
}

/** Log in (or re-authorize) a character via EVE SSO. Opens the browser. */
export function authLogin(): Promise<Character> {
  return invoke<Character>("auth_login");
}

/** The current character roster. */
export function authCharacters(): Promise<Character[]> {
  return invoke<Character[]>("auth_characters");
}

/** Remove a character; returns the updated roster. */
export function authLogout(characterId: number): Promise<Character[]> {
  return invoke<Character[]>("auth_logout", { characterId });
}

export interface OwnedBlueprint {
  characterId: number;
  characterName: string;
  /** True for a corporation blueprint, false for a personal one. */
  corporation: boolean;
  /** The blueprint's type id (matches a production row's blueprintTypeId). */
  typeId: number;
  materialEfficiency: number;
  timeEfficiency: number;
  runs: number;
  quantity: number;
}

/** Blueprints owned across the whole roster (their real ME/TE). */
export function ownedBlueprints(): Promise<OwnedBlueprint[]> {
  return invoke<OwnedBlueprint[]>("owned_blueprints");
}

export interface Asset {
  typeId: number;
  quantity: number;
  locationId: number;
}

/** A character's assets. */
export function characterAssets(characterId: number): Promise<Asset[]> {
  return invoke<Asset[]>("character_assets", { characterId });
}

// --- Station trading ---

export interface TradeRow {
  typeId: number;
  name: string;
  buy: number;
  sell: number;
  profitPerUnit: number;
  margin: number;
  volume: number;
  favorite: boolean;
}

export interface TradeParams {
  regionId?: number;
  stationId?: number | null;
  brokerFee?: number;
  salesTax?: number;
  minVolume?: number;
}

/** Rank tradeable items by buy→sell margin at a market. */
export function stationTrading(params: TradeParams): Promise<TradeRow[]> {
  return invoke<TradeRow[]>("station_trading", { params });
}

export type ListName = "blacklist" | "favorites";

export interface ListItem {
  typeId: number;
  name: string;
}

/** Contents of a saved list (blacklist/favorites), with names. */
export function tradingGetList(list: ListName): Promise<ListItem[]> {
  return invoke<ListItem[]>("trading_get_list", { list });
}

/** Add/remove a type from a saved list. */
export function tradingSetList(
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>("trading_set_list", { list, typeId, add });
}

// --- SDE (Static Data Export) ---

export interface SdeStatus {
  installed: boolean;
  path: string;
  sizeBytes: number | null;
  /** Whether the call actually (re)downloaded the database. */
  updated: boolean;
}

export interface BlueprintMaterial {
  materialTypeId: number;
  name: string;
  quantity: number;
}

export interface BlueprintProduct {
  productTypeId: number;
  name: string;
  quantity: number;
}

export interface TypeInfo {
  typeId: number;
  name: string;
  groupId: number;
  groupName: string | null;
  volume: number | null;
}

export interface ManufacturableBlueprint {
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  productQuantity: number;
}

export interface SdeProgress {
  phase: "downloading" | "decompressing" | "verifying" | "done";
  downloaded: number;
  total: number | null;
}

/** Whether the local SDE database is installed, and where. */
export function sdeStatus(): Promise<SdeStatus> {
  return invoke<SdeStatus>("sde_status");
}

/** Download/refresh the SDE. No-op if installed unless `force` is true. */
export function sdeUpdate(force = false): Promise<SdeStatus> {
  return invoke<SdeStatus>("sde_update", { force });
}

export function sdeBlueprintMaterials(
  blueprintTypeId: number,
): Promise<BlueprintMaterial[]> {
  return invoke<BlueprintMaterial[]>("sde_blueprint_materials", {
    blueprintTypeId,
  });
}

export function sdeBlueprintProduct(
  blueprintTypeId: number,
): Promise<BlueprintProduct | null> {
  return invoke<BlueprintProduct | null>("sde_blueprint_product", {
    blueprintTypeId,
  });
}

export function sdeTypeInfo(typeId: number): Promise<TypeInfo | null> {
  return invoke<TypeInfo | null>("sde_type_info", { typeId });
}

export function sdeManufacturableBlueprints(): Promise<
  ManufacturableBlueprint[]
> {
  return invoke<ManufacturableBlueprint[]>("sde_manufacturable_blueprints");
}

/** Subscribe to SDE download/decompress progress. */
export function onSdeProgress(
  handler: (progress: SdeProgress) => void,
): Promise<UnlistenFn> {
  return listen<SdeProgress>("sde://progress", (event) =>
    handler(event.payload),
  );
}

// --- Markets ---

/** A station within a region. */
export interface Station {
  id: number;
  name: string;
}

/** A selectable region with its hub station(s). */
export interface Region {
  id: number;
  name: string;
  stations: Station[];
}

/** The selectable regions, each with its hub station. */
export function marketRegions(): Promise<Region[]> {
  return invoke<Region[]>("market_regions");
}

// --- Production profit ---

export interface MaterialLine {
  typeId: number;
  name: string;
  requiredQuantity: number;
  unitPrice: number | null;
  lineCost: number;
  /** True when building this input is cheaper than buying it. */
  built: boolean;
}

export interface InventionBreakdown {
  datacores: MaterialLine[];
  datacoreCost: number;
  inventionJobFee: number;
  copyFee: number;
  attemptCost: number;
  /** Skill-adjusted success probability (0..1). */
  probability: number;
  runsPerSuccess: number;
  /** Invention cost per produced unit. */
  perUnit: number;
}

export interface ProfitBreakdown {
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  runs: number;
  me: number;
  unitsProduced: number;
  materialCost: number;
  jobFee: number;
  /** Amortized blueprint acquisition cost for this job (per-run cost × runs). */
  blueprintCost: number;
  /** Amortized invention cost for this job (T2 items; 0 otherwise). */
  inventionCost: number;
  /** Invention cost detail (T2 items only). */
  invention: InventionBreakdown | null;
  revenue: number;
  profit: number;
  /** profit / revenue, or null when revenue is zero. Capped at 100%. */
  margin: number | null;
  /** return on investment: profit / cost. Can exceed 100%. Null if cost is 0. */
  roi: number | null;
  profitPerUnit: number;
  /** Meta group of the product (Tech I/II, Faction, Officer, …). */
  metaGroup: string | null;
  /** Category of the product (Ship, Module, Charge, …). */
  category: string | null;
  /** Which market this result was priced at. */
  market: string | null;
  /** Product market volume (units listed), or null. */
  productVolume: number | null;
  /** Per-unit sell price of the product (the target price), or null. */
  productPrice: number | null;
  materials: MaterialLine[];
  /** type ids that couldn't be priced; numbers are incomplete when non-empty. */
  missingPrices: number[];
}

export type PriceBasis =
  | "sellMin"
  | "buyMax"
  | "sellPercentile"
  | "buyPercentile"
  | "adjustedPrice"
  | "averagePrice";

export interface ProfitParams {
  /** Region to price against (default The Forge). */
  regionId?: number;
  /** Station within the region; null/undefined = region average. */
  stationId?: number | null;
  runs?: number;
  me?: number;
  systemCostIndex?: number;
  facilityTax?: number;
  materialBasis?: PriceBasis;
  productBasis?: PriceBasis;
  /** Amortized blueprint acquisition cost per run (e.g. faction BPC). */
  blueprintCostPerRun?: number;
  /** Inventor skill level 0..5 scaling invention probability (default 5). */
  inventionSkillLevel?: number;
}

/** Rank every manufacturable item by build-vs-buy profit at the chosen market. */
export function productionProfit(
  params: ProfitParams,
): Promise<ProfitBreakdown[]> {
  return invoke<ProfitBreakdown[]>("production_profit", { params });
}
