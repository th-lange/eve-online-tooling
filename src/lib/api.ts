// Typed wrappers around Tauri `invoke`. Every Rust command the frontend calls
// is exposed here so components depend on a small typed surface rather than raw
// string command names.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Health-check the Rust bridge. Returns `"pong"`. */
export function ping(): Promise<string> {
  return invoke<string>("ping");
}

// --- SDE (Static Data Export) ---

export interface SdeStatus {
  installed: boolean;
  path: string;
  sizeBytes: number | null;
  /** Whether the call actually (re)downloaded the database. */
  updated: boolean;
}

export interface BlueprintMaterial {
  materialTypeId: number;
  name: string;
  quantity: number;
}

export interface BlueprintProduct {
  productTypeId: number;
  name: string;
  quantity: number;
}

export interface TypeInfo {
  typeId: number;
  name: string;
  groupId: number;
  groupName: string | null;
  volume: number | null;
}

export interface ManufacturableBlueprint {
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  productQuantity: number;
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

export function sdeBlueprintMaterials(
  blueprintTypeId: number,
): Promise<BlueprintMaterial[]> {
  return invoke<BlueprintMaterial[]>("sde_blueprint_materials", {
    blueprintTypeId,
  });
}

export function sdeBlueprintProduct(
  blueprintTypeId: number,
): Promise<BlueprintProduct | null> {
  return invoke<BlueprintProduct | null>("sde_blueprint_product", {
    blueprintTypeId,
  });
}

export function sdeTypeInfo(typeId: number): Promise<TypeInfo | null> {
  return invoke<TypeInfo | null>("sde_type_info", { typeId });
}

export function sdeManufacturableBlueprints(): Promise<
  ManufacturableBlueprint[]
> {
  return invoke<ManufacturableBlueprint[]>("sde_manufacturable_blueprints");
}

/** Subscribe to SDE download/decompress progress. */
export function onSdeProgress(
  handler: (progress: SdeProgress) => void,
): Promise<UnlistenFn> {
  return listen<SdeProgress>("sde://progress", (event) =>
    handler(event.payload),
  );
}

// --- Market prices ---

/** All price vectors for a type. Each is null when no data is available. */
export interface PriceModel {
  typeId: number;
  sellMin: number | null;
  buyMax: number | null;
  adjustedPrice: number | null;
  averagePrice: number | null;
  dailyAverage: number | null;
  dailyVolume: number | null;
  orderCount: number | null;
  movingAverage: number | null;
}

/** Price model (all vectors) for one type. */
export function marketPrice(typeId: number): Promise<PriceModel> {
  return invoke<PriceModel>("market_price", { typeId });
}

/** Price models for many types in one call. */
export function marketPrices(typeIds: number[]): Promise<PriceModel[]> {
  return invoke<PriceModel[]>("market_prices", { typeIds });
}

// --- Production profit ---

export interface MaterialLine {
  typeId: number;
  name: string;
  requiredQuantity: number;
  unitPrice: number | null;
  lineCost: number;
}

export interface ProfitBreakdown {
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  runs: number;
  me: number;
  unitsProduced: number;
  materialCost: number;
  jobFee: number;
  revenue: number;
  profit: number;
  /** profit / revenue, or null when revenue is zero. Capped at 100%. */
  margin: number | null;
  /** return on investment: profit / cost. Can exceed 100%. Null if cost is 0. */
  roi: number | null;
  profitPerUnit: number;
  /** Meta group of the product (Tech I/II, Faction, Officer, …). */
  metaGroup: string | null;
  /** Product daily volume (liquidity), or null. */
  productVolume: number | null;
  materials: MaterialLine[];
  /** type ids that couldn't be priced; numbers are incomplete when non-empty. */
  missingPrices: number[];
}

export type PriceBasis =
  | "sellMin"
  | "buyMax"
  | "dailyAverage"
  | "movingAverage"
  | "adjustedPrice"
  | "averagePrice";

export type ProfitMode = "selected" | "all";

export interface ProfitParams {
  mode?: ProfitMode;
  /** Used in "selected" mode. */
  blueprintTypeIds?: number[];
  runs?: number;
  me?: number;
  systemCostIndex?: number;
  facilityTax?: number;
  materialBasis?: PriceBasis;
  productBasis?: PriceBasis;
}

/** Evaluate and rank the given blueprints by build-vs-buy profit (desc). */
export function productionProfit(
  params: ProfitParams,
): Promise<ProfitBreakdown[]> {
  return invoke<ProfitBreakdown[]>("production_profit", { params });
}
