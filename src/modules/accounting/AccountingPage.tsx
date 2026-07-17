import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  errorMessage,
  isAuthRequired,
  profitFifo,
  walletSync,
  type ProfitView,
  type WalletView,
} from "../../lib/api";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { Stat } from "../../components/Stat";

type Tab = "wallet" | "profit";

const TITLE = "Accounting";
const SUBTITLE =
  "Wallet journal (accumulated beyond ESI's window) and FIFO realized profit, for your first logged-in character.";

export function AccountingPage() {
  const [tab, setTab] = useState<Tab>("wallet");
  const wallet = useMutation({ mutationFn: walletSync });
  const profit = useMutation({ mutationFn: profitFifo });

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <PrimaryButton
            onClick={() =>
              tab === "wallet" ? wallet.mutate() : profit.mutate()
            }
            disabled={wallet.isPending || profit.isPending}
            pending={wallet.isPending || profit.isPending}
            pendingLabel="Syncing…"
          >
            Sync
          </PrimaryButton>
        }
      />

      <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
        {(["wallet", "profit"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm ${
              tab === t
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t === "wallet" ? "Wallet" : "Profit (FIFO)"}
          </button>
        ))}
      </div>

      <div className="mt-3">
        {tab === "wallet" ? (
          wallet.isError ? (
            <Err e={wallet.error} />
          ) : wallet.data ? (
            <Wallet d={wallet.data} />
          ) : (
            <Hint>Hit Sync to pull and accumulate your wallet.</Hint>
          )
        ) : profit.isError ? (
          <Err e={profit.error} />
        ) : profit.data ? (
          <Profit d={profit.data} />
        ) : (
          <Hint>
            Hit Sync (on the Wallet tab first) to compute realized profit from
            your transactions.
          </Hint>
        )}
      </div>
    </Page>
  );
}

type PivotSortKey = "refType" | "income" | "expense" | "net";
const PIVOT_COLUMNS: SortColumn<PivotSortKey>[] = [
  {
    key: "refType",
    label: "Type",
    numeric: false,
    description: "Transaction category.",
  },
  {
    key: "income",
    label: "Income",
    numeric: true,
    description: "Total credited.",
  },
  {
    key: "expense",
    label: "Expense",
    numeric: true,
    description: "Total debited.",
  },
  { key: "net", label: "Net", numeric: true, description: "Income − expense." },
];
const PIVOT_KEYS = PIVOT_COLUMNS.map((c) => c.key);

type RecentSortKey = "date" | "refType" | "amount" | "balance";
const RECENT_COLUMNS: SortColumn<RecentSortKey>[] = [
  {
    key: "date",
    label: "Date / time",
    numeric: false,
    description: "When the entry posted (UTC).",
  },
  {
    key: "refType",
    label: "Type",
    numeric: false,
    description: "Transaction category.",
  },
  {
    key: "amount",
    label: "Amount",
    numeric: true,
    description: "Signed ISK movement.",
  },
  {
    key: "balance",
    label: "Balance",
    numeric: true,
    description: "Wallet balance after the entry.",
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
      <div className="mt-1 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <Head columns={PIVOT_COLUMNS} sort={pivotSort} />
          <tbody>
            {pivots.map((p, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
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
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="mt-4 text-sm font-medium text-zinc-300">Recent entries</h3>
      <div className="mt-1 max-h-96 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <Head columns={RECENT_COLUMNS} sort={recentSort} />
          <tbody>
            {recent.map((e, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1 whitespace-nowrap text-zinc-400">
                  {fmtDate(e.date)}
                </td>
                <td className="px-3 py-1">{e.refType.replace(/_/g, " ")}</td>
                <td
                  className={`px-3 py-1 text-right tabular-nums ${
                    e.amount >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {formatIsk(e.amount)}
                </td>
                <td className="px-3 py-1 text-right tabular-nums text-zinc-400">
                  {formatIsk(e.balance)}
                </td>
              </tr>
            ))}
            {recent.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-zinc-500">
                  No journal entries yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
          value={formatIsk(d.totalProfit)}
          accent="text-emerald-400"
        />
      </div>
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <Head columns={PROFIT_COLUMNS} sort={sort} />
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
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
                  {formatIsk(r.profit)}
                </td>
                <td className="px-3 py-1.5 text-zinc-500">
                  {fmtDate(r.lastSold)}
                </td>
              </tr>
            ))}
            {d.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-zinc-500">
                  No sales in your transaction history yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A sortable header row driven by a usePersistentSort result. */
function Head<K extends string>({
  columns,
  sort,
}: {
  columns: SortColumn<K>[];
  sort: { sortKey: K; sortDir: "asc" | "desc"; toggleSort: (k: K) => void };
}) {
  return (
    <thead className="bg-zinc-900 text-zinc-400">
      <tr>
        {columns.map((c) => (
          <SortHeaderCell
            key={c.key}
            column={c}
            active={sort.sortKey === c.key}
            dir={sort.sortDir}
            onClick={sort.toggleSort}
          />
        ))}
      </tr>
    </thead>
  );
}

/** ESI timestamps to a compact local `YYYY-MM-DD HH:MM`. */
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-8 text-center text-sm text-zinc-500">{children}</div>
  );
}
function Err({ e }: { e: unknown }) {
  if (isAuthRequired(e)) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        Log in a character first to view your wallet.
      </div>
    );
  }
  return (
    <div className="p-6 text-sm text-rose-400">
      {errorMessage(e)} — check the wallet scope is enabled on your EVE app.
    </div>
  );
}
