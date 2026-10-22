import { invoke } from "@tauri-apps/api/core";

export interface AssetRow {
  typeId: number;
  name: string;
  quantity: number;
  sellPrice: number | null;
  buyPrice: number | null;
  sellValue: number;
  buyValue: number;
  volume: number;
  category: string | null;
  group: string | null;
  /** Character name, or the corporation name for corp-hangar stock. */
  owner: string;
  isCorp: boolean;
  /** The root station/structure id this stack sits at — stable across
   *  renders (unlike `station`, a resolved display name), so callers can
   *  key "how much of type X do I have at location Y" lookups on it. */
  locationId: number;
  /** NPC station name or "Structure {id}" for player structures. */
  station: string;
  /** Solar system the station sits in, if resolvable from SDE. */
  solarSystem: string | null;
}

export interface AssetNode {
  id: number;
  name: string;
  typeId: number | null;
  quantity: number;
  /** Rolled-up sell value of this node and everything under it. */
  sellValue: number;
  volume: number;
  isLocation: boolean;
  /** Owning character or corp (set on item nodes). */
  owner: string | null;
  isCorp: boolean;
  /** Classifiers for item nodes, for tree search. */
  category: string | null;
  group: string | null;
  metaGroup: string | null;
  children: AssetNode[];
}

/** Both views derived from one ESI load. */
export interface AssetsPayload {
  rows: AssetRow[];
  roots: AssetNode[];
  sellTotal: number;
  buyTotal: number;
  volumeTotal: number;
}

/** Load the roster's assets — flat rows + location tree — in one call. */
export function assetsLoad(): Promise<AssetsPayload> {
  return invoke<AssetsPayload>("assets_load");
}

/** One station/structure the roster has assets at (see `assetsLocations`). */
export interface AssetLocation {
  /** Root station/structure id — matches `AssetRow.locationId`. */
  id: number;
  name: string;
  solarSystem: string | null;
}

/** How many of one item type sit at a location (see `assetsStockAtLocation`). */
export interface StockEntry {
  typeId: number;
  quantity: number;
}

/** Every station/structure the roster has assets at, sorted by name. A cheap
 *  read of the same cached item data as `assetsLoad` — no Jita pricing — for
 *  populating location pickers. */
export function assetsLocations(): Promise<AssetLocation[]> {
  return invoke<AssetLocation[]>("assets_locations");
}

/** Stock of each item type at one station/structure (including items nested
 *  in containers/ships there), summed across the whole roster's personal and
 *  corp hangars. No pricing. */
export function assetsStockAtLocation(
  locationId: number,
): Promise<StockEntry[]> {
  return invoke<StockEntry[]>("assets_stock_at_location", { locationId });
}
