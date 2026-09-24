import {
  commands,
  type CurrentLocation,
  type DepthLevel,
  type HistoryPoint,
  type OrderBook,
  type PriceModel,
  type Region,
  type SellOrder,
  type SellOrdersParams,
  type Station,
} from "./generated/market";
import { unwrapCommand, type IdName } from "./common";

export type {
  CurrentLocation,
  DepthLevel,
  HistoryPoint,
  OrderBook,
  PriceModel,
  Region,
  SellOrder,
  SellOrdersParams,
  Station,
};

/** Daily market history for a type in a region (ascending by date). */
export async function marketHistory(
  regionId: number,
  typeId: number,
): Promise<HistoryPoint[]> {
  return unwrapCommand(await commands.marketHistory(regionId, typeId));
}

/** Current prices for a type in a region (optionally a single station). */
export async function marketPrice(
  regionId: number,
  typeId: number,
  stationId?: number | null,
): Promise<PriceModel> {
  return unwrapCommand(
    await commands.marketPrice(regionId, stationId ?? null, typeId),
  );
}

/** The selectable regions, each with its hub station. */
export async function marketRegions(): Promise<Region[]> {
  return commands.marketRegions();
}

// --- Market search (order list + jumps) ---

/** Every known-space region (id, name) for the region picker. */
export async function marketAllRegions(): Promise<IdName[]> {
  return unwrapCommand(await commands.marketAllRegions());
}

/** Search NPC stations by name (for the optional station filter). */
export async function marketSearchStations(query: string): Promise<IdName[]> {
  return unwrapCommand(await commands.marketSearchStations(query));
}

/** The logged-in character's current system + region (null if not available). */
export async function marketCurrentLocation(): Promise<CurrentLocation | null> {
  return unwrapCommand(await commands.marketCurrentLocation());
}

/** Sell orders for a type across the chosen scope, cheapest first. */
export async function marketSellOrders(
  params: SellOrdersParams,
): Promise<SellOrder[]> {
  return unwrapCommand(await commands.marketSellOrders(params));
}

/** Aggregated buy + sell order book for a type across the chosen scope. */
export async function marketOrderBook(
  params: SellOrdersParams,
): Promise<OrderBook> {
  return unwrapCommand(await commands.marketOrderBook(params));
}
