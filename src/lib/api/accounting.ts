import { invoke } from "@tauri-apps/api/core";

export interface RecentEntry {
  date: string;
  refType: string;
  amount: number;
  balance: number;
  description: string;
}
export interface WalletView {
  balance: number;
  incomeTotal: number;
  expenseTotal: number;
  entryCount: number;
  transactionCount: number;
  pivots: { refType: string; income: number; expense: number }[];
  recent: RecentEntry[];
}
export function walletSync(): Promise<WalletView> {
  return invoke<WalletView>("accounting_wallet_sync");
}

export interface ProfitView {
  rows: {
    name: string;
    unitsSold: number;
    revenue: number;
    cost: number;
    profit: number;
    unmatchedUnits: number;
    lastSold: string;
  }[];
  totalProfit: number;
}
export function profitFifo(): Promise<ProfitView> {
  return invoke<ProfitView>("accounting_profit_fifo");
}

/** One market transaction (a single buy or sell fill). */
export interface LedgerRow {
  date: string;
  name: string;
  typeId: number;
  isBuy: boolean;
  quantity: number;
  unitPrice: number;
  /** quantity × unit price. */
  total: number;
}
export interface LedgerView {
  rows: LedgerRow[];
  totalBuy: number;
  totalSell: number;
}
/**
 * Per-fill buy/sell transaction history for the active character (newest
 * first), refreshed from ESI and accumulated durably. Needs the wallet scope.
 */
export function transactionLedger(): Promise<LedgerView> {
  return invoke<LedgerView>("accounting_transaction_ledger");
}
