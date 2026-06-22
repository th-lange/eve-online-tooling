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
