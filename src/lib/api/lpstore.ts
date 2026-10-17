import { invoke } from "@tauri-apps/api/core";

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

/** One LP-store offer for a matching item, tagged with the corp selling it. */
export interface LpSearchRow extends OfferRow {
  corporationId: number;
  corporation: string;
}
export interface LpSearchResult {
  /** Unix seconds of the oldest per-corp offers pull used by the scan. */
  oldestFetchedAt: number;
  /** Corps skipped this scan (transient ESI errors) — result may be partial. */
  failedCorporations: number;
  rows: LpSearchRow[];
}
export interface LpSearchParams {
  query: string;
  iskPerLp?: number;
  refresh?: boolean;
}
/** Search every NPC corp's LP store for offers of an item (public, cached). */
export function lpSearch(params: LpSearchParams): Promise<LpSearchResult> {
  return invoke<LpSearchResult>("lp_search", { params });
}
