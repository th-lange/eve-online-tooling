import { invoke } from "@tauri-apps/api/core";
import type { ListName, ListItem } from "./common";

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
