import { invoke } from "@tauri-apps/api/core";

export interface TradeRow {
  typeId: number;
  name: string;
  buy: number;
  sell: number;
  profitPerUnit: number;
  margin: number;
  /** Sell-side order-book depth — units listed in sell orders. */
  volume: number;
  /** Buy-side order-book depth — units listed in buy orders. */
  buyVolume: number;
  /** Buy depth ÷ sell depth — demand vs supply pressure (>1 = more buyers). */
  buySellRatio: number;
  /** Average units traded per day, from market history (buys == sells). */
  dailyTraded: number;
  /** Sell depth ÷ daily-traded — days of supply on the book. */
  daysOfSupply: number;
  /** Set when the current sell sits at a recent price extreme, else null. */
  priceFlag: string | null;
  /** Fractional price move over the recent window (last vs first quarter, vol-weighted); null when thin. */
  changePct: number | null;
  /** Daily average price over the trend window (oldest→newest), for a sparkline. */
  trend: number[];
  favorite: boolean;
  category: string | null;
  group: string | null;
  metaGroup: string | null;
}

export interface TradeParams {
  regionId?: number;
  stationId?: number | null;
  brokerFee?: number;
  salesTax?: number;
  minVolume?: number;
}

/** Rank tradeable items by buy→sell margin at a market. */
export function stationTrading(params: TradeParams): Promise<TradeRow[]> {
  return invoke<TradeRow[]>("trading_scan", { params });
}
