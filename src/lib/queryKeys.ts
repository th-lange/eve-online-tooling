// ALL TanStack Query keys live here — not just ones shared across more than
// one component. Centralizing every key (instead of hardcoding arrays at
// each call site) keeps invalidation dependencies grep-able (search for the
// domain's export to find every reader/writer) and rules out cache bugs
// from a typo'd literal that silently misses its sibling key.
//
// Kept out of component files so react-refresh can hot-reload those cleanly.

import { queryOptions } from "@tanstack/react-query";
import {
  assetsLoad,
  assetsLocations,
  assetsStockAtLocation,
  marketHistory,
  marketRegions,
  sdeSearch,
  type FeedbackDraft,
  type ListModule,
  type ListName,
} from "./api";
import type { Fresh } from "./api/common";

/** Key for the shopping lists; shared so "add to list" buttons can invalidate
 *  the Shopping page from anywhere. */
export const SHOPPING_LISTS_KEY = ["shopping", "lists"] as const;

/** The roster's ESI assets. `load` is the priced flat+tree payload the Assets
 *  page renders; `staleTime` mirrors the backend's own 600s per-character
 *  cache (`assets_load`), so a second mount within that window reuses the
 *  cached payload instead of round-tripping through Tauri again.
 *
 *  `locations` / `stockAt` are the pricing-free reads Mass Production's
 *  stock-location picker uses — same 600s backend cache, no Jita valuation.
 *  `stockAll` is the prefix that sweeps every per-location stock entry. */
export const assetsKeys = {
  load: () =>
    queryOptions({
      queryKey: ["assets", "load"] as const,
      queryFn: assetsLoad,
      staleTime: 600_000,
    }),
  locations: () =>
    queryOptions({
      queryKey: ["assets", "locations"] as const,
      queryFn: assetsLocations,
      staleTime: 600_000,
    }),
  stockAll: ["assets", "stock"] as const,
  stockAt: (locationId: number) =>
    queryOptions({
      queryKey: ["assets", "stock", locationId] as const,
      queryFn: () => assetsStockAtLocation(locationId),
      staleTime: 600_000,
    }),
};

// --- Market ---

/** Fallback when the backend has no cached `expiresAt` yet (cache disabled,
 *  or nothing fetched): ESI history is published once a day, and the
 *  backend's own conditional cache already holds the same call ~20 min
 *  server-side, so a long client stale time just avoids redundant refetches
 *  of data that hasn't moved. This is the value PriceHistoryPopover used
 *  stand-alone before it and the Market Search history tab were unified
 *  onto this one key: fetching the same region+type from either surface
 *  now shares a single cache entry instead of double-fetching. */
const MARKET_HISTORY_STALE_TIME = 30 * 60 * 1000;

/** Time remaining (ms) until a `Fresh` envelope's server-derived cache
 *  deadline, floored at 0 — TanStack's dynamic `staleTime` form calls this
 *  with the query's raw (pre-`select`) cached data on every staleness
 *  check (#885), so it reflects ESI's real `Cache-Control`/`Expires`
 *  window instead of a hand-guessed constant. Falls back to `fallbackMs`
 *  when the envelope carries no `expiresAt` (not fetched yet, or the
 *  backend's conditional cache is disabled). */
function staleTimeFromFresh(
  fresh: Fresh<unknown> | undefined,
  fallbackMs: number,
): number {
  if (fresh?.expiresAt == null) return fallbackMs;
  return Math.max(0, fresh.expiresAt - Date.now());
}

/** The region/trade-hub list is baked into the backend (market service
 *  `markets.rs`), so it can only change with an app update — like the SDE it
 *  is static for the whole session. A long stale time stops every page mount
 *  and window refocus from refetching a constant list. */
const MARKET_REGIONS_STALE_TIME = 24 * 60 * 60 * 1000;

export const marketKeys = {
  /** The static region + trade-hub list backing every region dropdown
   *  (trading, daytrading, reprocessing, fitting, contracts, production
   *  workbench, appraisal, …). One shared key so all pages read a single
   *  cache entry instead of each forking its own. */
  regions: () =>
    queryOptions({
      queryKey: ["market", "regions"] as const,
      queryFn: marketRegions,
      staleTime: MARKET_REGIONS_STALE_TIME,
    }),
  /** Daily price/volume history for a type in a region. `typeId` is nullable
   *  so callers can build the key before an item is picked; pair with
   *  `enabled: typeId != null` on the query. `select` projects the `Fresh`
   *  envelope down to the plain `HistoryPoint[]` every existing caller
   *  expects — `staleTime` still sees the full envelope via the query's
   *  raw cached data, so it can derive from `expiresAt` (#885). */
  history: (regionId: number, typeId: number | null | undefined) =>
    queryOptions({
      queryKey: ["market", "history", regionId, typeId] as const,
      queryFn: () => marketHistory(regionId, typeId as number),
      staleTime: (query) =>
        staleTimeFromFresh(query.state.data, MARKET_HISTORY_STALE_TIME),
      select: (fresh) => fresh.data,
    }),
  /** MarketSearchPage's full region list (distinct cache entry from
   *  `regions()` above — kept byte-identical to the pre-refactor literal). */
  allRegions: ["market", "all-regions"] as const,
  /** MarketSearchPage's "current location" region lookup. */
  currentLocation: ["market", "current-location"] as const,
  /** Pochven EntryFinder's own "current location" lookup — a separately
   *  spelled (and thus separately cached) key from `currentLocation` above;
   *  kept as two keys since this is a pure refactor, not a behavior fix. */
  currentLocationCamel: ["market", "currentLocation"] as const,
  orderBook: <R, T>(regionId: R, typeId: T) =>
    ["market", "order-book", regionId, typeId] as const,
};

// --- SDE ---

/** The SDE only changes on a daily refresh (see SdeGate's `["sde","status"]`
 *  poll) and is otherwise fully static, so a search result for a given query
 *  string stays valid for the rest of the session — there's no live signal
 *  that would ever invalidate it sooner. 24h errs on the safe side of "until
 *  the next refresh" without needing to coordinate with the refresh event. */
export const SDE_SEARCH_STALE_TIME = 24 * 60 * 60 * 1000;

export const sdeKeys = {
  /** Marketable-type name search backing every item picker (command palette,
   *  module browser, shopping list add, market search, …). */
  search: (q: string) =>
    queryOptions({
      queryKey: ["sde", "search", q] as const,
      queryFn: () => sdeSearch(q),
      staleTime: SDE_SEARCH_STALE_TIME,
    }),
  /** Daily SDE-refresh poll (SdeGate). */
  status: ["sde", "status"] as const,
  /** Market-category tree for Daytrading's category picker. */
  marketCategories: ["sde", "marketCategories"] as const,
};

// --- Auth ---

/** The logged-in character roster + active-character selection. `all` is
 *  the prefix every per-character query root is swept with on login/logout/
 *  switch (see `Characters.tsx`'s `PER_CHARACTER_QUERY_ROOTS`). */
export const authKeys = {
  all: ["auth"] as const,
  characters: ["auth", "characters"] as const,
  active: ["auth", "active"] as const,
};

// --- Ammo ---

export const ammoKeys = {
  reference: <F>(family: F) => ["ammo", "reference", family] as const,
};

// --- Character (per-character tabs on CharacterPage) ---

export const charKeys = {
  all: ["char"] as const,
  skills: <I>(activeId: I) => ["char", "skills", activeId] as const,
  standings: <I>(activeId: I) => ["char", "standings", activeId] as const,
  research: <I>(activeId: I) => ["char", "research", activeId] as const,
  mining: <I>(activeId: I) => ["char", "mining", activeId] as const,
  fleet: <I>(activeId: I) => ["char", "fleet", activeId] as const,
};

/** Trade-fee (broker/sales tax) lookup — a distinct "character" domain from
 *  `charKeys` above (kept byte-identical to the pre-refactor literals). */
export const characterKeys = {
  all: ["character"] as const,
  tradeFees: <I>(characterId: I) =>
    ["character", "tradeFees", characterId] as const,
};

// --- Combo (generic searchable combobox's default cache key) ---

export const comboKeys = {
  default: <L, T>(label: L, text: T) => ["combo", label, text] as const,
};

// --- DPS meter ---

export const dpsKeys = {
  characters: <D>(gamelogsDir: D) =>
    ["dps", "characters", gamelogsDir] as const,
};

// --- ESI (misc character-scoped ESI reads not under another domain) ---

export const esiKeys = {
  all: ["esi"] as const,
  characterShip: ["esi", "character-ship"] as const,
};

// --- Faction warfare / intel ---

export const intelKeys = {
  incursions: ["intel", "incursions"] as const,
  fw: ["intel", "fw"] as const,
  fwSystems: ["intel", "fwSystems"] as const,
  fwEnlistment: ["intel", "fw-enlistment"] as const,
  fwJumps: <S>(systemIds: S) => ["intel", "fw-jumps", systemIds] as const,
  fwPersonalStats: ["intel", "fw-personal-stats"] as const,
  fwHotspots: <A, B>(myFaction: A, enemyFaction: B) =>
    ["intel", "fw-hotspots", myFaction, enemyFaction] as const,
};

// --- Feedback ---

export const feedbackKeys = {
  all: ["feedback"] as const,
  status: ["feedback", "status"] as const,
  history: ["feedback", "history"] as const,
  preview: (draft: FeedbackDraft) => ["feedback", "preview", draft] as const,
};

// --- Fitting ---

export const fittingKeys = {
  saved: ["fitting", "saved"] as const,
  esi: ["fitting", "esi"] as const,
  local: ["fitting", "local"] as const,
  hullInfos: <H>(hullIds: H) => ["fitting", "hullInfos", hullIds] as const,
  targetProfiles: ["fitting", "targetProfiles"] as const,
  layout: <S>(shipTypeId: S) => ["fitting", "layout", shipTypeId] as const,
  names: <I>(itemIds: I) => ["fitting", "names", itemIds] as const,
  simulate: <F, S, N, T, B, E, A, Sp, Fr>(
    fitKey: F,
    skillSource: S,
    neutGjs: N,
    targetProfile: T,
    fleetBoosts: B,
    environmentEffect: E,
    abyssalWeather: A,
    spoolPct: Sp,
    factorReload: Fr,
  ) =>
    [
      "fitting",
      "simulate",
      fitKey,
      skillSource,
      neutGjs,
      targetProfile,
      fleetBoosts,
      environmentEffect,
      abyssalWeather,
      spoolPct,
      factorReload,
    ] as const,
  environmentEffects: ["fitting", "environmentEffects"] as const,
  charges: <T>(typeId: T) => ["fitting", "charges", typeId] as const,
  mutaplasmids: <T>(typeId: T) => ["fitting", "mutaplasmids", typeId] as const,
  mutationRanges: <T, S>(typeId: T, selectedId: S) =>
    ["fitting", "mutationRanges", typeId, selectedId] as const,
  ammoTable: <F, S>(fit: F, skillSource: S) =>
    ["fitting", "ammoTable", fit, skillSource] as const,
  ammoTableCompare: <F, S>(fit: F, skillSource: S) =>
    ["fitting", "ammoTable-compare", fit, skillSource] as const,
  compatibleCharges: <M>(moduleId: M) =>
    ["fitting", "compatible-charges", moduleId] as const,
  moduleInfo: <S, K, I>(shipTypeId: S, skillSource: K, ids: I) =>
    ["fitting", "module-info", shipTypeId, skillSource, ids] as const,
  mgTree: <P>(parentId: P) => ["fitting", "mg-tree", parentId] as const,
};

// --- Industry ---

export const industryKeys = {
  all: ["industry"] as const,
  jobs: <C>(characterId: C) => ["industry", "jobs", characterId] as const,
};

// --- Info ---

export const infoKeys = {
  all: ["info"] as const,
};

// --- Local intel ---

export const localintelKeys = {
  systemKills: <S>(systemId: S) =>
    ["localintel", "system-kills", systemId] as const,
  watchlist: ["localintel", "watchlist"] as const,
  location: ["localintel", "location"] as const,
  hood: <S, D>(systemId: S, depth: D) =>
    ["localintel", "hood", systemId, depth] as const,
};

// --- Logs ---

export const logsKeys = {
  list: ["logs_list"] as const,
};

// --- LP store ---

export const lpKeys = {
  balances: ["lp", "balances"] as const,
};

// --- Mass production ---

export const massprodKeys = {
  lists: ["massprod", "lists"] as const,
};

// --- MCP ---

export const mcpKeys = {
  all: ["mcp"] as const,
  config: ["mcp", "config"] as const,
};

// --- Notifications ---

export const notificationsKeys = {
  all: ["notifications"] as const,
  forCharacter: <C>(characterId: C) => ["notifications", characterId] as const,
};

// --- Orders ---

export const ordersKeys = {
  all: ["orders"] as const,
  market: <C>(characterId: C) => ["orders", "market", characterId] as const,
};

// --- Owned (roster-wide "Owned" filter, backing Assets + Mass Production) ---

export const ownedKeys = {
  all: ["owned"] as const,
  blueprints: ["owned", "blueprints"] as const,
};

// --- Ping ---

export const pingKeys = {
  all: ["ping"] as const,
};

// --- PI ---

export const piKeys = {
  all: ["pi"] as const,
  overview: <C>(characterId: C) => ["pi", "overview", characterId] as const,
  locked: ["pi", "locked"] as const,
  productionChain: <P>(id: P) => ["pi", "production-chain", id] as const,
  planetsInSystem: <S>(systemId: S) =>
    ["pi", "planets-in-system", systemId] as const,
  setups: ["pi", "planner-setups"] as const,
};

// --- Plugins ---

export const pluginsKeys = {
  all: ["plugins"] as const,
  dir: ["plugins", "dir"] as const,
};

// --- Pochven ---

export const pochvenKeys = {
  search: <S, M>(systemId: S, maxJumps: M) =>
    ["pochven", "search", systemId, maxJumps] as const,
  map: ["pochven", "map"] as const,
  routes: ["pochven", "routes"] as const,
};

// --- Production ---

export const productionKeys = {
  decryptors: ["production", "decryptors"] as const,
  costIndex: <P>(regionId: P) => ["production", "costIndex", regionId] as const,
  buildCosts: ["production", "buildCosts"] as const,
};

// --- PvP ---

export const pvpKeys = {
  ammo: <W, S>(weaponTypeId: W, shipTypeId: S) =>
    ["pvp", "ammo", weaponTypeId, shipTypeId] as const,
  typical: <H>(hullTypeId: H) => ["pvp", "typical", hullTypeId] as const,
  fits: <C>(characterId: C) => ["pvp", "fits", characterId] as const,
  profileName: <N>(name: N) => ["pvp", "profile-name", name] as const,
  fightFitStats: <F>(fitId: F) => ["pvp", "fight-fit-stats", fitId] as const,
};

// --- Release check ---

export const releaseCheckKeys = {
  all: ["release-check"] as const,
};

// --- Reprocessing ---

export const reprocessingKeys = {
  eff: <R, E, O, I, Rg, St, Se>(
    reproc: R,
    reprocEff: E,
    oreProc: O,
    implantPct: I,
    rigBonusPct: Rg,
    structureMult: St,
    securityMult: Se,
  ) =>
    [
      "reprocessing",
      "eff",
      reproc,
      reprocEff,
      oreProc,
      implantPct,
      rigBonusPct,
      structureMult,
      securityMult,
    ] as const,
};

// --- Roster (shared cross-module "roster stock" cache) ---

export const rosterKeys = {
  stock: ["roster", "stock"] as const,
};

// --- Route ---

export const routeKeys = {
  systemActivity: ["route", "systemActivity"] as const,
  breadcrumb: ["route", "breadcrumb"] as const,
  neighbourhood: <C, D>(centreId: C, depth: D) =>
    ["route", "neighbourhood", centreId, depth] as const,
  liveLocation: ["route", "liveLocation"] as const,
};

// --- Saved lists (favorites/blacklist shared by trading/daytrading/
//     reprocessing/production workbenches) ---

export const savedListKeys = {
  favorites: (module: ListModule) => [module, "favorites"] as const,
  blacklist: (module: ListModule) => [module, "blacklist"] as const,
  forList: (module: ListModule, list: ListName) => [module, list] as const,
};

// --- Scripts ---

export const scriptsKeys = {
  all: ["scripts"] as const,
  examples: ["scripts", "examples"] as const,
};

// --- Shopping (chat sync; SHOPPING_LISTS_KEY above covers the lists root) ---

export const shoppingKeys = {
  chatSync: <D, C>(logsDir: D, channel: C) =>
    ["shopping", "chatSync", logsDir, channel] as const,
};

// --- Market search (MarketSearchPage-local root keys — unprefixed by
//     "market", kept byte-identical to their pre-refactor values) ---

export const marketSearchKeys = {
  price: <R, T>(regionId: R, typeId: T) => ["price", regionId, typeId] as const,
  sellOrders: <T, R, S, St, O, H, E>(
    typeId: T,
    regionId: R,
    systemId: S,
    stationId: St,
    originId: O,
    highSecOnly: H,
    excludeScams: E,
  ) =>
    [
      "sell-orders",
      typeId,
      regionId,
      systemId,
      stationId,
      originId,
      highSecOnly,
      excludeScams,
    ] as const,
  orderBook: <T, R, S, St, E>(
    typeId: T,
    regionId: R,
    systemId: S,
    stationId: St,
    excludeScams: E,
  ) =>
    [
      "order-book",
      typeId,
      regionId,
      systemId,
      stationId,
      excludeScams,
    ] as const,
};

// --- Transactions ---

export const transactionsKeys = {
  all: ["transactions"] as const,
  ledger: <C>(characterId: C) =>
    ["transactions", "ledger", characterId] as const,
};

// --- Universe browser ---

export const uniKeys = {
  cats: ["uni", "cats"] as const,
  groups: <C, P>(categoryId: C, publishedOnly: P) =>
    ["uni", "groups", categoryId, publishedOnly] as const,
  types: <G, P>(groupId: G, publishedOnly: P) =>
    ["uni", "types", groupId, publishedOnly] as const,
  detail: <T>(typeId: T) => ["uni", "detail", typeId] as const,
  attrs: <T>(typeId: T) => ["uni", "attrs", typeId] as const,
};

// --- Wormholes ---

export const whKeys = {
  connections: ["wh", "connections"] as const,
  typeReference: ["wh", "typeReference"] as const,
  systemRef: <S>(systemId: S) => ["wh", "systemRef", systemId] as const,
  tripwireStatus: ["wh", "tripwireStatus"] as const,
  signatures: <S>(systemId: S) => ["wh", "signatures", systemId] as const,
};
