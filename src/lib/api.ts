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
  /** Blueprint name from the SDE, e.g. "Hobgoblin II Blueprint". */
  name: string;
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

/** Open the in-game market window for a type (needs a logged-in character + the
 * esi-ui.open_window scope). */
export function openMarketWindow(typeId: number): Promise<void> {
  return invoke<void>("open_market_window", { typeId });
}

/**
 * Total owned quantity per type across the whole roster (durably cached ~10min).
 * Keys are type ids (as strings, per JSON object keys).
 */
export function rosterStock(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("roster_stock");
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
  /** Buy depth ÷ sell depth — demand vs supply pressure (>1 = more buyers). */
  buySellRatio: number;
  /** Average units traded per day, from market history (buys == sells). */
  dailyTraded: number;
  /** Sell depth ÷ daily-traded — days of supply on the book. */
  daysOfSupply: number;
  /** Set when the current sell sits at a recent price extreme, else null. */
  priceFlag: string | null;
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
  /** Net profit per unit after sales tax + broker fee + shipping. */
  profitPerUnit: number;
  /** Hauling cost per unit (volume × shipping rate). */
  shippingPerUnit: number;
  margin: number;
  /** Packaged volume per unit, m³. */
  volumeM3: number;
  /** Profit per m³ of cargo (the hauler's metric). */
  iskPerM3: number;
  /** Daily-traded volume at the sell hub (how much you can offload). */
  destVolume: number;
  /** Suggested quantity over the purchase window (dest volume × days). */
  suggestedQty: number;
  /** Total profit at the suggested quantity. */
  totalProfit: number;
  /** Sell-hub order-book supply ÷ daily-traded (how contested the sell side is). */
  daysOfSupply: number;
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
  /** Hauling cost in ISK per m³. */
  shippingRate?: number;
  minProfit?: number;
  /** Days of demand to stock (suggested qty = sell-hub volume × this). */
  purchaseDays?: number;
  /** Drop rows whose sell-hub daily-traded volume is below this. */
  minDailyDemand?: number;
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

// --- Reprocessing (reprocess-vs-sell) ---

export interface ReprocessOutput {
  typeId: number;
  name: string;
  /** Units yielded per one input unit, after efficiency. */
  perUnit: number;
  unitPrice: number | null;
  value: number;
}

export interface ReprocessRow {
  typeId: number;
  name: string;
  /** Sell price of the ore itself (per unit). */
  sellPrice: number | null;
  /** Refine value per unit (outputs valued at the chosen market). */
  reprocessValue: number;
  /** reprocessValue − sellPrice (positive = refining wins). */
  delta: number;
  /** reprocessValue / sellPrice − 1, or null. */
  uplift: number | null;
  outputs: ReprocessOutput[];
  favorite: boolean;
  group: string | null;
  missingPrices: number[];
}

export interface ReprocessParams {
  regionId?: number;
  stationId?: number | null;
  reprocessing?: number;
  reprocessingEfficiency?: number;
  oreProcessing?: number;
  implantPct?: number;
  rigBonusPct?: number;
  structureMult?: number;
  securityMult?: number;
}

/** Rank ores by reprocess-vs-sell at a market. */
export function reprocessingScan(params: ReprocessParams): Promise<ReprocessRow[]> {
  return invoke<ReprocessRow[]>("reprocessing_scan", { params });
}

/** The reprocessing efficiency (0..1) for the given skill/structure inputs. */
export function reprocessingEfficiency(params: ReprocessParams): Promise<number> {
  return invoke<number>("reprocessing_efficiency", { params });
}

export function reprocessingGetList(list: ListName): Promise<ListItem[]> {
  return invoke<ListItem[]>("reprocessing_get_list", { list });
}

export function reprocessingSetList(
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>("reprocessing_set_list", { list, typeId, add });
}

// --- Appraisal ---

export interface AppraisalLine {
  name: string;
  typeId: number | null;
  quantity: number;
  buyPrice: number | null;
  sellPrice: number | null;
  buyValue: number;
  sellValue: number;
  sellHub: string | null;
  volume: number;
  resolved: boolean;
}

export interface AppraisalResult {
  lines: AppraisalLine[];
  buyTotal: number;
  sellTotal: number;
  volumeTotal: number;
}

export interface AppraisalParams {
  items: { name: string; quantity: number }[];
  regionId?: number;
  stationId?: number | null;
  bestHub?: boolean;
}

/** Value a pasted inventory (buy & sell) at a market, with total cargo volume. */
export function appraisal(params: AppraisalParams): Promise<AppraisalResult> {
  return invoke<AppraisalResult>("appraisal", { params });
}

// --- Assets ---

export interface AssetRow {
  typeId: number;
  name: string;
  quantity: number;
  sellPrice: number | null;
  buyPrice: number | null;
  sellValue: number;
  buyValue: number;
  sellHub: string | null;
  volume: number;
  category: string | null;
  group: string | null;
}

export interface AssetsResult {
  rows: AssetRow[];
  sellTotal: number;
  buyTotal: number;
  volumeTotal: number;
}

export interface AssetsParams {
  regionId?: number;
  stationId?: number | null;
  bestHub?: boolean;
}

/** Value the roster's holdings at a market (or best hub). */
export function assetsValue(params: AssetsParams): Promise<AssetsResult> {
  return invoke<AssetsResult>("assets_value", { params });
}

// --- Character (skills / standings / research) ---

export interface SkillsView {
  totalSp: number;
  unallocatedSp: number;
  trainedCount: number;
  queue: { skillName: string; level: number; finishDate: string | null }[];
}
export function characterSkills(): Promise<SkillsView> {
  return invoke<SkillsView>("character_skills");
}

export interface StandingRow {
  name: string;
  fromType: string;
  base: number;
  effective: number;
  skill: string;
}
export function characterStandings(): Promise<StandingRow[]> {
  return invoke<StandingRow[]>("character_standings");
}

export interface ResearchView {
  rows: {
    agent: string;
    skill: string;
    pointsPerDay: number;
    currentPoints: number;
  }[];
  totalPoints: number;
  pointsPerDay: number;
}
export function characterResearch(): Promise<ResearchView> {
  return invoke<ResearchView>("character_research");
}

export interface MiningView {
  units24h: number;
  units7d: number;
  units30d: number;
  value24h: number;
  value7d: number;
  value30d: number;
  rows: { name: string; quantity: number; value: number }[];
  systems: string[];
}
export function characterMining(): Promise<MiningView> {
  return invoke<MiningView>("character_mining");
}

export interface FleetView {
  inFleet: boolean;
  members: {
    name: string;
    ship: string;
    system: string;
    role: string;
    joined: string;
  }[];
}
export function characterFleet(): Promise<FleetView> {
  return invoke<FleetView>("character_fleet");
}

// --- Accounting (wallet + FIFO profit) ---

export interface WalletView {
  balance: number;
  incomeTotal: number;
  expenseTotal: number;
  entryCount: number;
  transactionCount: number;
  pivots: { refType: string; income: number; expense: number }[];
}
export function walletSync(): Promise<WalletView> {
  return invoke<WalletView>("wallet_sync");
}

export interface ProfitView {
  rows: {
    name: string;
    unitsSold: number;
    revenue: number;
    cost: number;
    profit: number;
    unmatchedUnits: number;
  }[];
  totalProfit: number;
}
export function profitFifo(): Promise<ProfitView> {
  return invoke<ProfitView>("profit_fifo");
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

// --- Universe / item browser ---

export interface IdName {
  id: number;
  name: string;
}

export interface TypeDetail {
  typeId: number;
  name: string;
  description: string | null;
  mass: number | null;
  volume: number | null;
  capacity: number | null;
  portionSize: number | null;
  marketGroupId: number | null;
  published: boolean;
  basePrice: number | null;
}

export interface AttrPair {
  name: string;
  value: number;
}

export function sdeCategories(): Promise<IdName[]> {
  return invoke<IdName[]>("sde_categories");
}
export function sdeGroups(categoryId: number, publishedOnly: boolean): Promise<IdName[]> {
  return invoke<IdName[]>("sde_groups", { categoryId, publishedOnly });
}
export function sdeTypes(groupId: number, publishedOnly: boolean): Promise<IdName[]> {
  return invoke<IdName[]>("sde_types", { groupId, publishedOnly });
}
export function sdeTypeDetail(typeId: number): Promise<TypeDetail | null> {
  return invoke<TypeDetail | null>("sde_type_detail", { typeId });
}
export function sdeTypeAttributes(typeId: number): Promise<AttrPair[]> {
  return invoke<AttrPair[]>("sde_type_attributes", { typeId });
}
/** Search marketable types by name (for pickers). */
export function sdeSearch(query: string): Promise<IdName[]> {
  return invoke<IdName[]>("sde_search", { query });
}

// --- Market history ---

export interface HistoryPoint {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  volume: number;
  orderCount: number;
}

/** Daily market history for a type in a region (ascending by date). */
export function marketHistory(regionId: number, typeId: number): Promise<HistoryPoint[]> {
  return invoke<HistoryPoint[]>("market_history", { regionId, typeId });
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
  /** Units covered from owned stock; lineCost only pays the shortfall. */
  have: number;
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
  /** Total manufacturing time for the job (all runs), in seconds; 0 if unknown. */
  jobTimeSeconds: number;
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
  /** Best hub to sell the product at (when "sell at best hub" is on), else null. */
  sellHub: string | null;
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
  /** Per-blueprint researched ME (blueprintTypeId → ME); overrides `me` for owned BPs. */
  ownedMe?: Record<number, number>;
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
  /** Price the product at whichever hub pays the most (materials stay local). */
  productBestHub?: boolean;
  /** Time efficiency (default for un-owned blueprints), 0..20. */
  te?: number;
  /** Per-blueprint researched TE (blueprintTypeId → TE); overrides te for owned. */
  ownedTe?: Record<number, number>;
  /** Industry time-skill level 0..5 (Industry + Advanced Industry). */
  timeSkill?: number;
  /** Structure time-efficiency bonus %, e.g. Raitaru 15 / Sotiyo 30. */
  structureTePct?: number;
  /** Combined structure+rig material multiplier (1.0 = none, 0.99 = −1%). */
  meBonus?: number;
  /** Combined structure+rig cost saving on the cost-index portion (0..1). */
  costBonus?: number;
  /** SCC surcharge fraction of EIV (default 0.04). */
  sccSurcharge?: number;
  /** Owned stock per type id; netted against the top-level bill of materials. */
  stock?: Record<number, number>;
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
