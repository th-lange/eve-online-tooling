import { invoke } from "@tauri-apps/api/core";

export interface AssetRow {
  typeId: number;
  name: string;
  quantity: number;
  sellPrice: number | null;
  buyPrice: number | null;
  sellValue: number;
  buyValue: number;
  sellHub: string | null;
  volume: number;
  category: string | null;
  group: string | null;
  /** Character name, or the corporation name for corp-hangar stock. */
  owner: string;
  isCorp: boolean;
}

export interface AssetsResult {
  rows: AssetRow[];
  sellTotal: number;
  buyTotal: number;
  volumeTotal: number;
}

export interface AssetsParams {
  regionId?: number;
  stationId?: number | null;
  bestHub?: boolean;
}

/** Value the roster's holdings at a market (or best hub). */
export function assetsValue(params: AssetsParams): Promise<AssetsResult> {
  return invoke<AssetsResult>("assets_value", { params });
}

export interface AssetNode {
  id: number;
  name: string;
  typeId: number | null;
  quantity: number;
  /** Rolled-up best-hub sell value of this node and everything under it. */
  sellValue: number;
  volume: number;
  bestHub: string | null;
  isLocation: boolean;
  /** Owning character or corp (set on item nodes; used for the per-item
   *  owner badge and owner search — the tree is not grouped by owner). */
  owner: string | null;
  isCorp: boolean;
  /** Classifiers for item nodes, for tree search. */
  category: string | null;
  group: string | null;
  metaGroup: string | null;
  children: AssetNode[];
}
export interface AssetsTreeResult {
  roots: AssetNode[];
  sellTotal: number;
  volumeTotal: number;
}

/** The roster's assets as a nested location tree, valued at the best hub. */
export function assetsTree(): Promise<AssetsTreeResult> {
  return invoke<AssetsTreeResult>("assets_tree");
}
