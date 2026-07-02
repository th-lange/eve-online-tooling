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
