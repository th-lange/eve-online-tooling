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
  return invoke<WalletView>("wallet_sync");
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
  return invoke<ProfitView>("profit_fifo");
}
