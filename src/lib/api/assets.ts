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
