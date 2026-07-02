import { invoke } from "@tauri-apps/api/core";
import type { ListName, ListItem } from "./common";

export interface ReprocessOutput {
  typeId: number;
  name: string;
  /** Units yielded per one input unit, after efficiency. */
  perUnit: number;
  unitPrice: number | null;
  value: number;
}

export interface ReprocessRow {
  typeId: number;
  name: string;
  /** Sell price of the ore itself (per unit). */
  sellPrice: number | null;
  /** Refine value per unit (outputs valued at the chosen market). */
  reprocessValue: number;
  /** reprocessValue − sellPrice (positive = refining wins). */
  delta: number;
  /** reprocessValue / sellPrice − 1, or null. */
  uplift: number | null;
  outputs: ReprocessOutput[];
  favorite: boolean;
  group: string | null;
  missingPrices: number[];
}

export interface ReprocessParams {
  regionId?: number;
  stationId?: number | null;
  reprocessing?: number;
  reprocessingEfficiency?: number;
  oreProcessing?: number;
  implantPct?: number;
  rigBonusPct?: number;
  structureMult?: number;
  securityMult?: number;
}

/** Rank ores by reprocess-vs-sell at a market. */
export function reprocessingScan(params: ReprocessParams): Promise<ReprocessRow[]> {
  return invoke<ReprocessRow[]>("reprocessing_scan", { params });
}

/** The reprocessing efficiency (0..1) for the given skill/structure inputs. */
export function reprocessingEfficiency(params: ReprocessParams): Promise<number> {
  return invoke<number>("reprocessing_efficiency", { params });
}

export function reprocessingGetList(list: ListName): Promise<ListItem[]> {
  return invoke<ListItem[]>("reprocessing_get_list", { list });
}

export function reprocessingSetList(
  list: ListName,
  typeId: number,
  add: boolean,
): Promise<void> {
  return invoke<void>("reprocessing_set_list", { list, typeId, add });
}
