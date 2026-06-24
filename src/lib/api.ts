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
  /** Sell-side order-book depth — units listed in sell orders. */
  volume: number;
  /** Buy-side order-book depth — units listed in buy orders. */
  buyVolume: number;
  /** Average units traded per day, from market history (buys == sells). */
  dailyTraded: number;
  favorite: boolean;
  category: string | null;
  group: string | null;
  /** Meta group (Tech I/II/III, Faction, …). */
  metaGroup: string | null;
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

// --- Daytrading (inter-station arbitrage) ---

export interface DayTradeRow {
  typeId: number;
  name: string;
  /** Hub to buy at (cheapest). */
  buyRegionId: number;
  buyHub: string;
  buyPrice: number;
  /** Hub to sell at (dearest). */
  sellRegionId: number;
  sellHub: string;
  sellPrice: number;
  /** Net profit per unit after sales tax + broker fee. */
  profitPerUnit: number;
  margin: number;
  /** Packaged volume per unit, m³. */
  volumeM3: number;
  /** Profit per m³ of cargo (the hauler's metric). */
  iskPerM3: number;
  /** Daily-traded volume at the sell hub (how much you can offload). */
  destVolume: number;
  favorite: boolean;
  category: string | null;
  group: string | null;
  /** Meta group (Tech I/II/III, Faction, …). */
  metaGroup: string | null;
}

export interface DayTradeParams {
  /** Region (hub) ids to scan; empty/omitted = all hubs. */
  regionIds?: number[];
  salesTax?: number;
  brokerFee?: number;
  minProfit?: number;
}

/** Rank items by inter-station arbitrage (buy source → sell destination). */
export function daytradingScan(params: DayTradeParams): Promise<DayTradeRow[]> {
  return invoke<DayTradeRow[]>("daytrading_scan", { params });
}

/** Contents of a daytrading saved list (blacklist/favorites), with names. */
export function daytradingGetList(list: ListName): Promise<ListItem[]> {
  return invoke<ListItem[]>("daytrading_get_list", { list });
}

/** Add/remove a type from a daytrading saved list. */
export function daytradingSetList(
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>("daytrading_set_list", { list, typeId, add });
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
  /** Group of the product (Frigate, Cruiser, …). */
  group: string | null;
  /** Which market this result was priced at. */
  market: string | null;
  /** Whether the user has favorited this item. */
  favorite: boolean;
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
  /** Decryptor applied to every T2 invention; null/undefined = none. */
  decryptorTypeId?: number | null;
}

/** Rank every manufacturable item by build-vs-buy profit at the chosen market. */
export function productionProfit(
  params: ProfitParams,
): Promise<ProfitBreakdown[]> {
  return invoke<ProfitBreakdown[]>("production_profit", { params });
}

/** An invention decryptor and its outcome modifiers (from the SDE). */
export interface Decryptor {
  typeId: number;
  name: string;
  /** Multiplier on invention success probability. */
  probabilityMultiplier: number;
  /** Added to the invented T2 BPC's material efficiency. */
  meModifier: number;
  /** Added to runs per successful invention. */
  runModifier: number;
}

/** The invention decryptors, for the production decryptor dropdown. */
export function productionDecryptors(): Promise<Decryptor[]> {
  return invoke<Decryptor[]>("production_decryptors");
}

/** Contents of a production saved list (blacklist/favorites), by blueprint id. */
export function productionGetList(list: ListName): Promise<ListItem[]> {
  return invoke<ListItem[]>("production_get_list", { list });
}

/** Add/remove a blueprint type from a production saved list. */
export function productionSetList(
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>("production_set_list", { list, typeId, add });
}
