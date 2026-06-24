import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  profitFifo,
  walletSync,
  type ProfitView,
  type WalletView,
} from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";

type Tab = "wallet" | "profit";

export function AccountingPage() {
  const [tab, setTab] = useState<Tab>("wallet");
  const wallet = useMutation({ mutationFn: walletSync });
  const profit = useMutation({ mutationFn: profitFifo });

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Accounting</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Wallet journal (accumulated beyond ESI's window) and FIFO realized
            profit, for your first logged-in character.
          </p>
        </div>
        <button
          onClick={() => (tab === "wallet" ? wallet.mutate() : profit.mutate())}
          disabled={wallet.isPending || profit.isPending}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {wallet.isPending || profit.isPending ? "Syncing…" : "Sync"}
        </button>
      </div>

      <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
        {(["wallet", "profit"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm ${
              tab === t ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
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
          <Hint>Hit Sync (on the Wallet tab first) to compute realized profit from your transactions.</Hint>
        )}
      </div>
    </div>
  );
}

function Wallet({ d }: { d: WalletView }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <Stat label="Balance" value={formatIsk(d.balance)} />
        <Stat label="Income (all time)" value={formatIsk(d.incomeTotal)} accent />
        <Stat label="Expense (all time)" value={formatIsk(d.expenseTotal)} />
        <Stat label="Journal entries" value={formatInt(d.entryCount)} />
        <Stat label="Transactions" value={formatInt(d.transactionCount)} />
      </div>
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Income</th>
              <th className="px-3 py-2 text-right font-medium">Expense</th>
              <th className="px-3 py-2 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {d.pivots.map((p, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">{p.refType.replace(/_/g, " ")}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                  {p.income > 0 ? formatIsk(p.income) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-rose-400">
                  {p.expense > 0 ? formatIsk(p.expense) : "—"}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {formatIsk(p.income - p.expense)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Profit({ d }: { d: ProfitView }) {
  return (
    <div>
      <div className="mb-3">
        <Stat label="Total realized profit" value={formatIsk(d.totalProfit)} accent />
      </div>
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Sold</th>
              <th className="px-3 py-2 text-right font-medium">Revenue</th>
              <th className="px-3 py-2 text-right font-medium">Cost (FIFO)</th>
              <th className="px-3 py-2 text-right font-medium">Profit</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
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
              </tr>
            ))}
            {d.rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-zinc-500">
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

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`tabular-nums ${accent ? "text-emerald-400" : "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
function Hint({ children }: { children: React.ReactNode }) {
  return <div className="p-8 text-center text-sm text-zinc-500">{children}</div>;
}
function Err({ e }: { e: unknown }) {
  return (
    <div className="p-6 text-sm text-rose-400">
      {String(e)} — log in a character and enable the wallet scope on your EVE app.
    </div>
  );
}
