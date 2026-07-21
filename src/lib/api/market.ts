import { invoke } from "@tauri-apps/api/core";
import type { IdName } from "./common";

export interface HistoryPoint {
  date: string;
  average: number;
  highest: number;
  lowest: number;
  volume: number;
  orderCount: number;
}

/** Daily market history for a type in a region (ascending by date). */
export function marketHistory(
  regionId: number,
  typeId: number,
): Promise<HistoryPoint[]> {
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

// --- Market search (order list + jumps) ---

/** Every known-space region (id, name) for the region picker. */
export function marketAllRegions(): Promise<IdName[]> {
  return invoke<IdName[]>("market_all_regions");
}

/** Search NPC stations by name (for the optional station filter). */
export function marketSearchStations(query: string): Promise<IdName[]> {
  return invoke<IdName[]>("market_search_stations", { query });
}

/** The logged-in character's current system + region (null if not available). */
export interface CurrentLocation {
  systemId: number;
  systemName: string;
  security: number;
  regionId: number;
  regionName: string;
}
export function marketCurrentLocation(): Promise<CurrentLocation | null> {
  return invoke<CurrentLocation | null>("market_current_location");
}

/** Filters for a market-search order query (all location fields optional). */
export interface SellOrdersParams {
  typeId: number;
  regionId?: number | null;
  systemId?: number | null;
  stationId?: number | null;
  /** Where the jumps column is measured from; omit for no jumps. */
  originSystemId?: number | null;
  /** Route only through high-sec (≥ 0.45) systems for the jumps count. */
  highSecOnly?: boolean;
  /** Drop outlier orders (scam guard) before listing. Default on. */
  excludeScams?: boolean;
}
/** One sell order in the order list, with location + jumps. */
export interface SellOrder {
  price: number;
  volumeRemain: number;
  stationId: number;
  stationName: string;
  systemId: number;
  systemName: string;
  regionName: string;
  security: number;
  jumps: number | null;
}

/** Sell orders for a type across the chosen scope, cheapest first. */
export function marketSellOrders(
  params: SellOrdersParams,
): Promise<SellOrder[]> {
  return invoke<SellOrder[]>("market_sell_orders", { params });
}

/** One aggregated price level in the order book. */
export interface DepthLevel {
  price: number;
  volume: number;
}

/** Aggregated buy + sell book for the depth chart (sell ascending, buy descending). */
export interface OrderBook {
  sell: DepthLevel[];
  buy: DepthLevel[];
}

/** Aggregated buy + sell order book for a type across the chosen scope. */
export function marketOrderBook(params: SellOrdersParams): Promise<OrderBook> {
  return invoke<OrderBook>("market_order_book", { params });
}
