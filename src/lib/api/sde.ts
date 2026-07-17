import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { IdName } from "./common";

export interface SdeStatus {
  installed: boolean;
  path: string;
  sizeBytes: number | null;
  /** Whether the call actually (re)downloaded the database. */
  updated: boolean;
}

export interface SdeProgress {
  phase: "downloading" | "decompressing" | "verifying" | "done";
  downloaded: number;
  total: number | null;
}

/** Whether the local SDE database is installed, and where. */
export function sdeStatus(): Promise<SdeStatus> {
  return invoke<SdeStatus>("sde_status");
}

/** Download/refresh the SDE. No-op if installed unless `force` is true. */
export function sdeUpdate(force = false): Promise<SdeStatus> {
  return invoke<SdeStatus>("sde_update", { force });
}

export interface TypeDetail {
  typeId: number;
  name: string;
  description: string | null;
  mass: number | null;
  volume: number | null;
  capacity: number | null;
  portionSize: number | null;
  marketGroupId: number | null;
  published: boolean;
  basePrice: number | null;
}

export interface AttrPair {
  name: string;
  value: number;
}

export function sdeCategories(): Promise<IdName[]> {
  return invoke<IdName[]>("sde_categories");
}
/** Categories that contain marketable items (for the daytrading whitelist). */
export function sdeMarketCategories(): Promise<IdName[]> {
  return invoke<IdName[]>("sde_market_categories");
}
export function sdeGroups(
  categoryId: number,
  publishedOnly: boolean,
): Promise<IdName[]> {
  return invoke<IdName[]>("sde_groups", { categoryId, publishedOnly });
}
export function sdeTypes(
  groupId: number,
  publishedOnly: boolean,
): Promise<IdName[]> {
  return invoke<IdName[]>("sde_types", { groupId, publishedOnly });
}
export function sdeTypeDetail(typeId: number): Promise<TypeDetail | null> {
  return invoke<TypeDetail | null>("sde_type_detail", { typeId });
}
export function sdeTypeAttributes(typeId: number): Promise<AttrPair[]> {
  return invoke<AttrPair[]>("sde_type_attributes", { typeId });
}
/** Search marketable types by name (for pickers). */
export function sdeSearch(query: string): Promise<IdName[]> {
  return invoke<IdName[]>("sde_search", { query });
}

/** Search published ships only (for the fitting hull picker). */
export function sdeSearchShips(query: string): Promise<IdName[]> {
  return invoke<IdName[]>("sde_search_ships", { query });
}

/** A market-group node in the browse tree. */
export interface MarketGroupNode {
  id: number;
  name: string;
  /** True when this group holds items directly (a leaf level). */
  hasTypes: boolean;
}

/** A leaf item with its meta-group label (Tech I/II, Faction…). */
export interface MarketGroupItem {
  id: number;
  name: string;
  metaGroup: string;
}

/** One level of the market-group tree: child groups + leaf items. */
export interface MarketGroupChildren {
  groups: MarketGroupNode[];
  items: MarketGroupItem[];
}

/** Children of a market group (or the top level when `parentId` is null) — for
 *  the fitting browse-by-category picker. Lazy-loaded per drill-down step. */
export function sdeMarketGroupChildren(
  parentId: number | null,
): Promise<MarketGroupChildren> {
  return invoke<MarketGroupChildren>("sde_market_group_children", { parentId });
}

/** Names for a set of type ids (bulk) — for showing item names instead of ids. */
export function sdeTypeNames(typeIds: number[]): Promise<IdName[]> {
  return invoke<IdName[]>("sde_type_names", { typeIds });
}

/** A type's id, name and group (for grouping fits by ship group). */
export interface TypeBrief {
  id: number;
  name: string;
  group: string;
}

/** `(id, name, group)` for a set of type ids (bulk). */
export function sdeTypeInfos(typeIds: number[]): Promise<TypeBrief[]> {
  return invoke<TypeBrief[]>("sde_type_infos", { typeIds });
}

/** Subscribe to SDE download/decompress progress. */
export function onSdeProgress(
  handler: (progress: SdeProgress) => void,
): Promise<UnlistenFn> {
  return listen<SdeProgress>("sde://progress", (event) =>
    handler(event.payload),
  );
}
