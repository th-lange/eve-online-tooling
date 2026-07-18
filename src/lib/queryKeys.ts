// Shared TanStack Query keys that more than one component invalidates/reads.
// Kept out of component files so react-refresh can hot-reload those cleanly.
//
// Scope rule: only keys backing shared lib/api calls used from MORE than one
// component belong here. Feature-local queries (e.g. a fitting module-info
// lookup used by a single panel) stay inline in their component file.

import { queryOptions } from "@tanstack/react-query";
import { marketHistory, marketRegions, sdeSearch } from "./api";

/** Key for the shopping lists; shared so "add to list" buttons can invalidate
 *  the Shopping page from anywhere. */
export const SHOPPING_LISTS_KEY = ["shopping", "lists"] as const;

// --- Market ---

/** ESI history is published once a day, and the backend's own conditional
 *  cache already holds the same call ~20 min server-side — a long client
 *  stale time just avoids redundant refetches of data that hasn't moved.
 *  This is the value PriceHistoryPopover used stand-alone before it and the
 *  Market Search history tab were unified onto this one key: fetching the
 *  same region+type from either surface now shares a single cache entry
 *  instead of double-fetching. */
const MARKET_HISTORY_STALE_TIME = 30 * 60 * 1000;

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
   *  `enabled: typeId != null` on the query. */
  history: (regionId: number, typeId: number | null | undefined) =>
    queryOptions({
      queryKey: ["market", "history", regionId, typeId] as const,
      queryFn: () => marketHistory(regionId, typeId as number),
      staleTime: MARKET_HISTORY_STALE_TIME,
    }),
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
};
