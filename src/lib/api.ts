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

/** Bookmark the "active" character used by per-character features. */
export function setActiveCharacter(characterId: number): Promise<void> {
  return invoke<void>("set_active_character", { characterId });
}

/** The active character id (bookmarked if set + in roster, else the first). */
export function activeCharacter(): Promise<number | null> {
  return invoke<number | null>("active_character");
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
  /**
   * Item category ids (a whitelist) to scan/price — only these are pulled at
   * each hub. Omitted = the default day-trade set (Ships + Modules + Charges);
   * `[]` = the whole catalogue.
   */
  categoryIds?: number[];
  /**
   * Owned stock per type id (from `rosterStock`), netted off the suggested
   * quantity. Omitted/empty = don't subtract (the "subtract owned stock" toggle off).
   */
  stock?: Record<number, number>;
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

export interface ReprocessInputLine {
  name: string;
  quantity: number;
  resolved: boolean;
  reprocessed: number;
  yieldValue: number;
}
export interface MineralLine {
  typeId: number;
  name: string;
  quantity: number;
  unitPrice: number | null;
  value: number;
}
export interface ReprocessAppraisalResult {
  inputs: ReprocessInputLine[];
  minerals: MineralLine[];
  mineralTotal: number;
  inputSellTotal: number;
  efficiency: number;
}
export interface ReprocessAppraisalParams {
  items: { name: string; quantity: number }[];
  regionId?: number;
  stationId?: number | null;
  efficiency?: number;
}
/** Paste ores/items → reprocessing mineral yield + value at a market. */
export function appraisalReprocess(
  params: ReprocessAppraisalParams,
): Promise<ReprocessAppraisalResult> {
  return invoke<ReprocessAppraisalResult>("appraisal_reprocess", { params });
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

export interface AssetNode {
  id: number;
  name: string;
  typeId: number | null;
  quantity: number;
  /** Rolled-up best-hub sell value of this node and everything under it. */
  sellValue: number;
  volume: number;
  bestHub: string | null;
  isLocation: boolean;
  children: AssetNode[];
}
export interface AssetsTreeResult {
  roots: AssetNode[];
  sellTotal: number;
  volumeTotal: number;
}

/** The roster's assets as a nested location tree, valued at the best hub. */
export function assetsTree(): Promise<AssetsTreeResult> {
  return invoke<AssetsTreeResult>("assets_tree");
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

export interface RecentEntry {
  date: string;
  refType: string;
  amount: number;
  balance: number;
  description: string;
}
export interface WalletView {
  balance: number;
  incomeTotal: number;
  expenseTotal: number;
  entryCount: number;
  transactionCount: number;
  pivots: { refType: string; income: number; expense: number }[];
  recent: RecentEntry[];
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
    lastSold: string;
  }[];
  totalProfit: number;
}
export function profitFifo(): Promise<ProfitView> {
  return invoke<ProfitView>("profit_fifo");
}

// --- Public contracts ---

export interface ContractRow {
  contractId: number;
  title: string;
  price: number;
  contentsValue: number;
  profit: number;
  roi: number;
  itemCount: number;
  hasBpc: boolean;
}

export interface ContractParams {
  regionId: number;
  minRoi?: number;
  /** Sales tax fraction applied to the resale (default 0.045). */
  salesTax?: number;
  /** Broker fee fraction applied to the resale (default 0.03). */
  brokerFee?: number;
}

/** Rank a region's public item-exchange contracts by flip ROI vs Jita. */
export function contractsScan(params: ContractParams): Promise<ContractRow[]> {
  return invoke<ContractRow[]>("contracts_scan", { params });
}

// --- LP store ---

export interface LpBalance {
  corporationId: number;
  corporation: string;
  points: number;
}
export function lpBalances(): Promise<LpBalance[]> {
  return invoke<LpBalance[]>("lp_balances");
}

export interface OfferRow {
  name: string;
  quantity: number;
  lpCost: number;
  iskCost: number;
  sellValue: number;
  cost: number;
  profit: number;
  iskPerLp: number;
}
export interface OffersResult {
  /** Unix seconds the offers were pulled from ESI (cached locally). */
  fetchedAt: number;
  rows: OfferRow[];
}
export interface LpParams {
  corporationId: number;
  iskPerLp?: number;
  refresh?: boolean;
}
export function lpOffers(params: LpParams): Promise<OffersResult> {
  return invoke<OffersResult>("lp_offers", { params });
}

// --- Industry Jobs ---

export interface JobRow {
  jobId: number;
  activity: string;
  product: string;
  runs: number;
  status: string;
  cost: number | null;
  startDate: string;
  endDate: string;
  facility: string;
  /** "You" for personal jobs, "Corp" for corporation jobs. */
  owner: string;
}

export interface Slot {
  used: number;
  total: number;
}
export interface Slots {
  manufacturing: Slot;
  science: Slot;
  reactions: Slot;
}
export interface JobsResult {
  jobs: JobRow[];
  /** Job-slot usage (used vs available), from the character's skills. */
  slots: Slots;
}

/**
 * A character's industry jobs (running + recently delivered) plus slot usage,
 * durably accumulated. `characterId` selects the roster character (default: first).
 * Requires `esi-industry.read_character_jobs.v1` (re-login if added).
 */
export function industryJobs(characterId?: number): Promise<JobsResult> {
  return invoke<JobsResult>("industry_jobs", { characterId });
}

// --- Market Orders ---

export interface OrderRow {
  orderId: number;
  typeId: number;
  name: string;
  isBuy: boolean;
  price: number;
  volumeRemain: number;
  volumeTotal: number;
  location: string;
  regionId: number;
  /** Best competing price at the order's region (sell-min / buy-max), or null. */
  bestPrice: number | null;
  /** True when someone is beating this order. */
  undercut: boolean;
  issued: string;
}

/**
 * The logged-in character's open market orders with undercut detection.
 * Requires the `esi-markets.read_character_orders.v1` scope (re-login if added).
 */
export function marketOrders(): Promise<OrderRow[]> {
  return invoke<OrderRow[]>("market_orders");
}

// --- Local Intel ---

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
  return invoke<LocalScanResult>("local_scan", { text });
}

export interface LocalLogResult {
  /** Pilots who spoke in the newest Local log (logs don't carry the member list). */
  senders: string[];
  file: string;
}

/** Speaker names from the newest `Local_*` chatlog in a user-configured folder. */
export function localLogNames(logsDir: string): Promise<LocalLogResult> {
  return invoke<LocalLogResult>("local_log_names", { logsDir });
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

// --- Route / system activity ---

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
  return invoke<SystemActivity[]>("system_activity", { refresh });
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
  return invoke<SystemMatch[]>("system_search", { query });
}

// --- Wormhole mapping ---

export interface ConnectionView {
  id: number;
  sourceSystemId: number;
  sourceName: string;
  sourceWspace: boolean;
  targetSystemId: number;
  targetName: string;
  targetWspace: boolean;
  scope: string;
  massStatus: string;
  jumpMass: string;
  eol: boolean;
  sourceSig: string | null;
  targetSig: string | null;
  createdAt: number;
}

export interface NewConnection {
  sourceSystemId: number;
  targetSystemId: number;
  scope?: string;
  sourceSig?: string | null;
  targetSig?: string | null;
}

/** Current wormhole/stargate connections (dead wormholes auto-pruned). */
export function whConnections(): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_connections");
}
export function whAddConnection(connection: NewConnection): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_add_connection", { connection });
}
export function whUpdateConnection(
  id: number,
  massStatus: string,
  jumpMass: string,
  eol: boolean,
  sourceSig: string | null,
  targetSig: string | null,
): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_update_connection", {
    id,
    massStatus,
    jumpMass,
    eol,
    sourceSig,
    targetSig,
  });
}
export function whDeleteConnection(id: number): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_delete_connection", { id });
}

export interface Signature {
  id: string;
  group: string;
  sigType: string;
  name: string;
}
export interface SignatureScan {
  signatures: Signature[];
  added: string[];
  removed: string[];
}

/** Paste a probe-scanner result for a system; returns the set + added/removed diff. */
export function whPasteSignatures(systemId: number, text: string): Promise<SignatureScan> {
  return invoke<SignatureScan>("wh_paste_signatures", { systemId, text });
}
/** Stored signatures for a system. */
export function whSignatures(systemId: number): Promise<Signature[]> {
  return invoke<Signature[]>("wh_signatures", { systemId });
}

export interface RouteHop {
  systemId: number;
  name: string;
  security: number;
  wspace: boolean;
  /** "origin" | "stargate" | "wormhole" — edge used to reach this hop. */
  via: string;
}
export interface RouteResult {
  hops: RouteHop[];
  reachable: boolean;
  jumps: number;
}

/** Route origin→destination over stargates ∪ mapped wormhole connections. */
export function whRoute(
  originSystemId: number,
  destinationSystemId: number,
  avoidEol: boolean,
): Promise<RouteResult> {
  return invoke<RouteResult>("wh_route", { originSystemId, destinationSystemId, avoidEol });
}

export interface BreadcrumbEntry {
  systemId: number;
  name: string;
  security: number;
  region: string;
  /** True for a wormhole (J-space) system. */
  wspace: boolean;
  enteredAt: number;
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

/** Stargate neighbourhood around a system out to `depth` jumps, with jumps/kills heat. */
export function systemNeighbourhood(
  systemId: number,
  depth: number,
): Promise<Neighbourhood> {
  return invoke<Neighbourhood>("system_neighbourhood", { systemId, depth });
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
/** Categories that contain marketable items (for the daytrading whitelist). */
export function sdeMarketCategories(): Promise<IdName[]> {
  return invoke<IdName[]>("sde_market_categories");
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

/** Multi-vector price model for a type at a market (current order book + globals). */
export interface PriceModel {
  typeId: number;
  /** Lowest sell order (what you pay to buy now). */
  sellMin?: number | null;
  /** Highest buy order (what you get selling now). */
  buyMax?: number | null;
  sellPercentile?: number | null;
  buyPercentile?: number | null;
  adjustedPrice?: number | null;
  averagePrice?: number | null;
  dailyAverage?: number | null;
  dailyVolume?: number | null;
  buyVolume?: number | null;
  orderCount?: number | null;
  movingAverage?: number | null;
}

/** Current prices for a type in a region (optionally a single station). */
export function marketPrice(
  regionId: number,
  typeId: number,
  stationId?: number | null,
): Promise<PriceModel> {
  return invoke<PriceModel>("market_price", {
    regionId,
    stationId: stationId ?? null,
    typeId,
  });
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
  /** Build sub-components (recursive build-vs-buy). False = buy all materials at market. Default true. */
  buildComponents?: boolean;
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
  | "cargo";

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
}

/** The editable fit document. */
export interface Fit {
  id: string;
  name: string;
  shipTypeId: number;
  items: FitItem[];
}

/** A hull's slot layout + fitting resources, for the empty editor. */
export interface ShipLayout {
  typeId: number;
  name: string;
  highSlots: number;
  midSlots: number;
  lowSlots: number;
  rigSlots: number;
  subsystemSlots: number;
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
  shieldRepS: number;
  armorRepS: number;
}

/** Full-application DPS by weapon kind. */
export interface DpsBreakdown {
  turret: number;
  missile: number;
  drone: number;
  total: number;
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
  targeting?: TargetStats | null;
  price?: number | null;
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

/** Serialize a fit to an EFT clipboard string. */
export function fittingExportEft(fit: Fit): Promise<string> {
  return invoke<string>("fitting_export_eft", { fit });
}

/** Skills basis for simulation: best-case all-V, or the logged-in character. */
export type SkillSource = "allFive" | "character";

/** Simulate a fit: validation + dogma stats at the chosen skill basis. */
export function fittingSimulate(
  fit: Fit,
  skillSource: SkillSource = "allFive",
): Promise<FitStats> {
  return invoke<FitStats>("fitting_simulate", { fit, skillSource });
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

/** Fill a fit's empty slots with the best modules for an objective, drawn from
 * the allowed meta groups (metaGroupIDs; e.g. [1,2] = Tech I + Tech II). Returns
 * the optimized fit. */
export function fittingOptimize(
  fit: Fit,
  objective: OptimizeObjective,
  metaGroups: number[],
): Promise<Fit> {
  return invoke<Fit>("fitting_optimize", { fit, objective, metaGroups });
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
export function fittingEsiList(): Promise<Fit[]> {
  return invoke<Fit[]>("fitting_esi_list");
}

/** A single locally saved fit by id, or `null`. */
export function fittingLoadLocal(id: string): Promise<Fit | null> {
  return invoke<Fit | null>("fitting_load_local", { id });
}

/** Delete a locally saved fit by id. */
export function fittingDeleteLocal(id: string): Promise<void> {
  return invoke<void>("fitting_delete_local", { id });
}
