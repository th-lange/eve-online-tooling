import { invoke } from "@tauri-apps/api/core";

export interface OrderRow {
  characterId: number;
  characterName: string;
  orderId: number;
  typeId: number;
  name: string;
  isBuy: boolean;
  price: number;
  volumeRemain: number;
  volumeTotal: number;
  location: string;
  regionId: number;
  /** The station/structure the order sits in (ESI location_id). */
  locationId: number;
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
