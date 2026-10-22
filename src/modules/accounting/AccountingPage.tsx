import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  profitFifo,
  transactionLedger,
  walletSync,
  type LedgerRow,
  type LedgerView,
  type ProfitView,
  type WalletView,
} from "../../lib/api";
import { QueryResult } from "../../components/QueryResult";
import {
  formatEveDateTime,
  formatInt,
  formatIsk,
  formatSignedIsk,
  sortRows,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import type { SortColumn } from "../../components/SortHeaderCell";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { Stat } from "../../components/Stat";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

type Tab = "wallet" | "profit" | "transactions";

const TITLE = "Accounting";
const SUBTITLE =
  "Wallet journal (accumulated beyond ESI's window) and FIFO realized profit, for your first logged-in character.";

export function AccountingPage() {
  const [tab, setTab] = useState<Tab>("wallet");
  const wallet = useMutation({ mutationFn: walletSync });
  const profit = useMutation({ mutationFn: profitFifo });
  const ledger = useMutation({ mutationFn: transactionLedger });

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <PrimaryButton
            onClick={() => {
              if (tab === "wallet") wallet.mutate();
              else if (tab === "profit") profit.mutate();
              else ledger.mutate();
            }}
            disabled={wallet.isPending || profit.isPending || ledger.isPending}
            pending={wallet.isPending || profit.isPending || ledger.isPending}
            pendingLabel="Syncing…"
          >
            Sync
          </PrimaryButton>
        }
      />

      <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
        {(
          [
            ["wallet", "Wallet"],
            ["profit", "Profit (FIFO)"],
            ["transactions", "Transactions"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm ${
              tab === t
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {tab === "wallet" ? (
          <QueryResult
            result={{
              isError: wallet.isError,
              error: wallet.error,
              isPending: wallet.isPending,
              data: wallet.data,
            }}
            pendingLabel="Syncing…"
            loginMessage="Log in a character first to view your wallet."
            scopeHint="check the wallet scope is enabled on your EVE app."
            emptyTitle="No wallet data yet."
            emptyHint="Hit Sync to pull and accumulate your wallet."
            updatedAt={wallet.isSuccess ? wallet.submittedAt : undefined}
            fetching={wallet.isPending}
          >
            {(d) => <Wallet d={d} />}
          </QueryResult>
        ) : tab === "profit" ? (
          <QueryResult
            result={{
              isError: profit.isError,
              error: profit.error,
              isPending: profit.isPending,
              data: profit.data,
            }}
            pendingLabel="Syncing…"
            loginMessage="Log in a character first to view your wallet."
            scopeHint="check the wallet scope is enabled on your EVE app."
            emptyTitle="No profit data yet."
            emptyHint="Hit Sync (on the Wallet tab first) to compute realized profit from your transactions."
            updatedAt={profit.isSuccess ? profit.submittedAt : undefined}
            fetching={profit.isPending}
          >
            {(d) => <Profit d={d} />}
          </QueryResult>
        ) : (
          <QueryResult
            result={{
              isError: ledger.isError,
              error: ledger.error,
              isPending: ledger.isPending,
              data: ledger.data,
            }}
            pendingLabel="Syncing…"
            loginMessage="Log in a character first to view your transactions."
            scopeHint="check the wallet scope is enabled on your EVE app."
            emptyTitle="No transaction data yet."
            emptyHint="Hit Sync to pull your buy/sell transaction history."
            updatedAt={ledger.isSuccess ? ledger.submittedAt : undefined}
            fetching={ledger.isPending}
          >
            {(d) => <Transactions d={d} />}
          </QueryResult>
        )}
      </div>
    </Page>
  );
}

type PivotSortKey = "refType" | "income" | "expense" | "net";
const PIVOT_COLUMNS: SortColumn<PivotSortKey>[] = [
  {
    key: "refType",
    label: "Category",
    numeric: false,
    description:
      "The wallet journal reference type (ESI's transaction category).",
  },
  {
    key: "income",
    label: "Income",
    numeric: true,
    description: "Total ISK received in this category.",
  },
  {
    key: "expense",
    label: "Expense",
    numeric: true,
    description: "Total ISK spent in this category.",
  },
  {
    key: "net",
    label: "Net",
    numeric: true,
    description: "Income minus expense for this category.",
  },
];
const PIVOT_KEYS = PIVOT_COLUMNS.map((c) => c.key);

type RecentSortKey = "date" | "refType" | "amount" | "balance";
const RECENT_COLUMNS: SortColumn<RecentSortKey>[] = [
  {
    key: "date",
    label: "Date",
    numeric: false,
    description: "When the journal entry occurred (UTC).",
  },
  {
    key: "refType",
    label: "Category",
    numeric: false,
    description: "The wallet journal reference type.",
  },
  {
    key: "amount",
    label: "Amount",
    numeric: true,
    description: "Signed ISK amount for this entry.",
  },
  {
    key: "balance",
    label: "Balance",
    numeric: true,
    description: "Wallet balance after this entry.",
  },
];
const RECENT_KEYS = RECENT_COLUMNS.map((c) => c.key);

function Wallet({ d }: { d: WalletView }) {
  const pivotSort = usePersistentSort<PivotSortKey>(
    "sort.wallet.pivot",
    PIVOT_KEYS,
    "net",
    "desc",
    ["refType"],
  );
  const recentSort = usePersistentSort<RecentSortKey>(
    "sort.wallet.recent",
    RECENT_KEYS,
    "date",
    "desc",
    ["date", "refType"],
  );
  const pivots = sortRows(
    d.pivots.map((p) => ({ ...p, net: p.income - p.expense })),
    pivotSort.sortKey,
    pivotSort.sortDir,
  );
  const recent = sortRows(d.recent, recentSort.sortKey, recentSort.sortDir);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <Stat label="Balance" value={formatIsk(d.balance)} />
        <Stat
          label="Income (all time)"
          value={formatIsk(d.incomeTotal)}
          accent="text-emerald-400"
        />
        <Stat label="Expense (all time)" value={formatIsk(d.expenseTotal)} />
        <Stat label="Journal entries" value={formatInt(d.entryCount)} />
        <Stat label="Transactions" value={formatInt(d.transactionCount)} />
      </div>
      <h3 className="text-sm font-medium text-zinc-300">By category</h3>
      <div className="mt-1">
        <DataTable
          columns={PIVOT_COLUMNS}
          sortKey={pivotSort.sortKey}
          sortDir={pivotSort.sortDir}
          onSort={pivotSort.toggleSort}
          rows={pivots}
          emptyState={<EmptyState title="No category activity yet." />}
          renderRow={(p) => (
            <tr
              key={p.refType}
              className="border-t border-zinc-800 text-zinc-300"
            >
              <td className="px-3 py-1.5">{p.refType.replace(/_/g, " ")}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                {p.income > 0 ? formatIsk(p.income) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-rose-400">
                {p.expense > 0 ? formatIsk(p.expense) : "—"}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {formatIsk(p.net)}
              </td>
            </tr>
          )}
        />
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-300">Recent entries</h3>
      <div className="mt-1 max-h-96 overflow-auto">
        <DataTable
          columns={RECENT_COLUMNS}
          sortKey={recentSort.sortKey}
          sortDir={recentSort.sortDir}
          onSort={recentSort.toggleSort}
          rows={recent}
          emptyState={<EmptyState title="No journal entries yet." />}
          renderRow={(e) => (
            <tr
              key={`${e.date}-${e.refType}-${e.amount}-${e.balance}`}
              className="border-t border-zinc-800 text-zinc-300"
            >
              <td className="px-3 py-1 whitespace-nowrap text-zinc-400">
                {formatEveDateTime(e.date)}
              </td>
              <td className="px-3 py-1">{e.refType.replace(/_/g, " ")}</td>
              <td
                className={`px-3 py-1 text-right tabular-nums ${
                  e.amount >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatSignedIsk(e.amount)}
              </td>
              <td className="px-3 py-1 text-right tabular-nums text-zinc-400">
                {formatIsk(e.balance)}
              </td>
            </tr>
          )}
        />
      </div>
    </div>
  );
}

type ProfitSortKey =
  "name" | "unitsSold" | "revenue" | "cost" | "profit" | "lastSold";
const PROFIT_COLUMNS: SortColumn<ProfitSortKey>[] = [
  { key: "name", label: "Item", numeric: false, description: "The item sold." },
  {
    key: "unitsSold",
    label: "Sold",
    numeric: true,
    description: "Units sold.",
  },
  {
    key: "revenue",
    label: "Revenue",
    numeric: true,
    description: "Total sale proceeds.",
  },
  {
    key: "cost",
    label: "Cost (FIFO)",
    numeric: true,
    description: "FIFO cost of the sold units.",
  },
  {
    key: "profit",
    label: "Profit",
    numeric: true,
    description: "Revenue − cost.",
  },
  {
    key: "lastSold",
    label: "Last sold",
    numeric: false,
    description: "Date of the most recent sale.",
  },
];
const PROFIT_KEYS = PROFIT_COLUMNS.map((c) => c.key);

function Profit({ d }: { d: ProfitView }) {
  const sort = usePersistentSort<ProfitSortKey>(
    "sort.profit",
    PROFIT_KEYS,
    "profit",
    "desc",
    ["name", "lastSold"],
  );
  const rows = sortRows(d.rows, sort.sortKey, sort.sortDir);
  return (
    <div>
      <div className="mb-3">
        <Stat
          label="Total realized profit"
          value={formatSignedIsk(d.totalProfit)}
          accent={d.totalProfit >= 0 ? "text-emerald-400" : "text-rose-400"}
        />
      </div>
      <DataTable
        columns={PROFIT_COLUMNS}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onSort={sort.toggleSort}
        rows={rows}
        emptyState={
          <EmptyState title="No sales in your transaction history yet." />
        }
        renderRow={(r) => (
          <tr key={r.name} className="border-t border-zinc-800 text-zinc-300">
            <td className="px-3 py-1.5">
              {r.name}
              {r.unmatchedUnits > 0 && (
                <span
                  className="ml-1 text-amber-400"
                  title={`${r.unmatchedUnits} units sold with no matching buy (cost basis 0)`}
                >
                  ⚠
                </span>
              )}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {formatInt(r.unitsSold)}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {formatIsk(r.revenue)}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {formatIsk(r.cost)}
            </td>
            <td
              className={`px-3 py-1.5 text-right tabular-nums ${
                r.profit >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {formatSignedIsk(r.profit)}
            </td>
            <td className="px-3 py-1.5 text-zinc-500">
              {formatEveDateTime(r.lastSold)}
            </td>
          </tr>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------- Transactions

type LedgerSortKey = "date" | "name" | "quantity" | "unitPrice" | "total";
const LEDGER_COLUMNS: SortColumn<LedgerSortKey>[] = [
  {
    key: "date",
    label: "Date",
    numeric: false,
    description: "When the transaction occurred (UTC).",
  },
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item bought or sold.",
  },
  {
    key: "quantity",
    label: "Qty",
    numeric: true,
    description: "Number of units in this fill.",
  },
  {
    key: "unitPrice",
    label: "Unit price",
    numeric: true,
    description: "ISK per unit.",
  },
  {
    key: "total",
    label: "Total ISK",
    numeric: true,
    description: "Total ISK moved (quantity × unit price).",
  },
];
const LEDGER_KEYS = LEDGER_COLUMNS.map((c) => c.key);

/** ISO date N months before now, for date-range filtering. */
function cutoffIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

const MONTH_OPTIONS: { label: string; months: number | null }[] = [
  { label: "1 m", months: 1 },
  { label: "3 m", months: 3 },
  { label: "6 m", months: 6 },
  { label: "12 m", months: 12 },
  { label: "All", months: null },
];

function Transactions({ d }: { d: LedgerView }) {
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [months, setMonths] = useState<number | null>(3);
  const query = useDebouncedValue(search.trim().toLowerCase());

  const sort = usePersistentSort<LedgerSortKey>(
    "sort.transactions",
    LEDGER_KEYS,
    "date",
    "desc",
    ["date", "name"],
  );

  const { rows, totalBuy, totalSell } = useMemo(() => {
    const cutoff = months != null ? cutoffIso(months) : null;
    let filtered = d.rows.filter((r: LedgerRow) => {
      if (cutoff && r.date < cutoff) return false;
      if (side === "buy" && !r.isBuy) return false;
      if (side === "sell" && r.isBuy) return false;
      if (query && !r.name.toLowerCase().includes(query)) return false;
      return true;
    });
    filtered = sortRows(filtered, sort.sortKey, sort.sortDir);
    let totalBuy = 0;
    let totalSell = 0;
    for (const r of filtered) {
      if (r.isBuy) totalBuy += r.total;
      else totalSell += r.total;
    }
    return { rows: filtered, totalBuy, totalSell };
  }, [d.rows, months, side, query, sort.sortKey, sort.sortDir]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search item…"
          className="h-8 w-52 rounded border border-zinc-700 bg-zinc-900 px-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
        />
        {/* Buy / Sell toggle */}
        <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
          {(["all", "buy", "sell"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`px-2.5 py-1 capitalize ${
                side === s
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        {/* Date range */}
        <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
          {MONTH_OPTIONS.map((o) => (
            <button
              key={o.label}
              onClick={() => setMonths(o.months)}
              className={`px-2.5 py-1 ${
                months === o.months
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {/* Summary */}
        <span className="ml-auto text-xs text-zinc-500">
          {formatInt(rows.length)} rows
          {side !== "sell" && totalBuy > 0 && (
            <>
              {" · "}
              <span className="text-rose-400">
                {formatIsk(totalBuy)} bought
              </span>
            </>
          )}
          {side !== "buy" && totalSell > 0 && (
            <>
              {" · "}
              <span className="text-emerald-400">
                {formatIsk(totalSell)} sold
              </span>
            </>
          )}
        </span>
      </div>

      {/* Table */}
      <DataTable
        columns={LEDGER_COLUMNS}
        sortKey={sort.sortKey}
        sortDir={sort.sortDir}
        onSort={sort.toggleSort}
        rows={rows}
        emptyState={
          <EmptyState title="No transactions match the current filters." />
        }
        renderRow={(r) => (
          <tr
            key={`${r.date}-${r.typeId}-${r.isBuy}-${r.quantity}-${r.unitPrice}`}
            className="border-t border-zinc-800 text-zinc-300"
          >
            <td className="whitespace-nowrap px-3 py-1.5 text-zinc-400">
              {formatEveDateTime(r.date)}
            </td>
            <td className="px-3 py-1.5">
              <span
                className={`mr-1.5 rounded px-1 py-0.5 text-[10px] font-medium uppercase ${
                  r.isBuy
                    ? "bg-rose-900/40 text-rose-300"
                    : "bg-emerald-900/40 text-emerald-300"
                }`}
              >
                {r.isBuy ? "buy" : "sell"}
              </span>
              {r.name}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {formatInt(r.quantity)}
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {formatIsk(r.unitPrice)}
            </td>
            <td
              className={`px-3 py-1.5 text-right tabular-nums ${
                r.isBuy ? "text-rose-300" : "text-emerald-300"
              }`}
            >
              {formatIsk(r.total)}
            </td>
          </tr>
        )}
      />
    </div>
  );
}
