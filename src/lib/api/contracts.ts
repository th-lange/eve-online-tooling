import { invoke } from "@tauri-apps/api/core";

export interface ContractRow {
  contractId: number;
  title: string;
  price: number;
  contentsValue: number;
  profit: number;
  roi: number;
  itemCount: number;
  hasBpc: boolean;
}

export interface ContractParams {
  regionId: number;
  minRoi?: number;
  /** Sales tax fraction applied to the resale (default 0.045). */
  salesTax?: number;
  /** Broker fee fraction applied to the resale (default 0.03). */
  brokerFee?: number;
}

/** Rank a region's public item-exchange contracts by flip ROI vs Jita. */
export function contractsScan(params: ContractParams): Promise<ContractRow[]> {
  return invoke<ContractRow[]>("contracts_scan", { params });
}
