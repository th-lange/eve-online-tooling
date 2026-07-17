import { invoke } from "@tauri-apps/api/core";

export interface AppraisalLine {
  name: string;
  typeId: number | null;
  quantity: number;
  buyPrice: number | null;
  sellPrice: number | null;
  buyValue: number;
  sellValue: number;
  sellHub: string | null;
  volume: number;
  resolved: boolean;
}

export interface AppraisalResult {
  lines: AppraisalLine[];
  buyTotal: number;
  sellTotal: number;
  volumeTotal: number;
}

export interface AppraisalParams {
  items: { name: string; quantity: number }[];
  regionId?: number;
  stationId?: number | null;
  bestHub?: boolean;
}

/** Value a pasted inventory (buy & sell) at a market, with total cargo volume. */
export function appraisal(params: AppraisalParams): Promise<AppraisalResult> {
  return invoke<AppraisalResult>("appraisal_run", { params });
}

export interface ReprocessInputLine {
  name: string;
  quantity: number;
  resolved: boolean;
  reprocessed: number;
  yieldValue: number;
}
export interface MineralLine {
  typeId: number;
  name: string;
  quantity: number;
  unitPrice: number | null;
  value: number;
}
export interface ReprocessAppraisalResult {
  inputs: ReprocessInputLine[];
  minerals: MineralLine[];
  mineralTotal: number;
  inputSellTotal: number;
  efficiency: number;
}
export interface ReprocessAppraisalParams {
  items: { name: string; quantity: number }[];
  regionId?: number;
  stationId?: number | null;
  efficiency?: number;
}
/** Paste ores/items → reprocessing mineral yield + value at a market. */
export function appraisalReprocess(
  params: ReprocessAppraisalParams,
): Promise<ReprocessAppraisalResult> {
  return invoke<ReprocessAppraisalResult>("appraisal_reprocess", { params });
}
