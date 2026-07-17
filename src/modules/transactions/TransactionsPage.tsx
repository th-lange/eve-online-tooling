import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { transactionLedger, type LedgerRow } from "../../lib/api";
import { QueryErrorNotice } from "../../components/QueryErrorNotice";
import { formatInt, formatIsk } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";

type Side = "all" | "buy" | "sell";

// A browsable ledger of the character's market buy/sell fills — the raw
// per-transaction history behind the FIFO profit tracker, so you can see how a
// given item actually traded for you. Backed by the wallet scope.
export function TransactionsPage() {
  const q = useQuery({
    queryKey: ["transactions", "ledger"],
    queryFn: transactionLedger,
    staleTime: 5 * 60_000,
  });
  const [side, setSide] = useState<Side>("all");
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    const term = search.trim().toLowerCase();
    return all.filter(
      (r) =>
        (side === "all" || (side === "buy" ? r.isBuy : !r.isBuy)) &&
        (term === "" || r.name.toLowerCase().includes(term)),
    );
  }, [q.data, side, search]);

  return (
    <Page>
      <PageHeader
        title="Transactions"
        subtitle="Every market buy and sell fill, newest first — how each item actually traded for you."
        actions={
          <button
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            title="Re-pull transactions from ESI"
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {q.isFetching ? "Syncing…" : "Refresh"}
          </button>
        }
      />
      <QueryErrorNotice
        error={q.error}
        loginMessage="Log in a character first to view their transaction history."
        scopeHint="check the wallet scope is enabled."
      />

      {q.data && (
        <div className="mt-4 flex flex-wrap gap-3">
          <Stat label="Bought" value={formatIsk(q.data.totalBuy)} tone="rose" />
          <Stat
            label="Sold"
            value={formatIsk(q.data.totalSell)}
            tone="emerald"
          />
          <Stat
            label="Net"
            value={formatIsk(q.data.totalSell - q.data.totalBuy)}
            tone={q.data.totalSell - q.data.totalBuy >= 0 ? "emerald" : "rose"}
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded border border-zinc-700 text-sm">
          {(["all", "buy", "sell"] as Side[]).map((s) => (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`px-3 py-1 capitalize ${
                side === s
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Filter by item…"
          className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
        {q.data && (
          <span className="text-xs text-zinc-500">
            {formatInt(rows.length)} of {formatInt(q.data.rows.length)} fills
          </span>
        )}
      </div>

      <Table rows={rows} loading={q.isLoading} />
    </Page>
  );
}

function Table({ rows, loading }: { rows: LedgerRow[]; loading: boolean }) {
  return (
    <div className="mt-4 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Date</th>
            <th className="px-3 py-1.5 text-left font-medium">Item</th>
            <th className="px-3 py-1.5 text-center font-medium">Side</th>
            <th className="px-3 py-1.5 text-right font-medium">Qty</th>
            <th className="px-3 py-1.5 text-right font-medium">Unit price</th>
            <th className="px-3 py-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-zinc-800 text-zinc-300">
              <td className="whitespace-nowrap px-3 py-1.5 text-zinc-500">
                {fmtDate(r.date)}
              </td>
              <td className="px-3 py-1.5">{r.name}</td>
              <td className="px-3 py-1.5 text-center">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    r.isBuy
                      ? "bg-rose-500/15 text-rose-300"
                      : "bg-emerald-500/15 text-emerald-300"
                  }`}
                >
                  {r.isBuy ? "Buy" : "Sell"}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.quantity)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.unitPrice)}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  r.isBuy ? "text-rose-400" : "text-emerald-400"
                }`}
              >
                {formatIsk(r.total)}
              </td>
            </tr>
          ))}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                No transactions.
              </td>
            </tr>
          )}
          {loading && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                Loading…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "rose" | "emerald";
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="text-xs text-zinc-500">{label}</div>
      <div
        className={`tabular-nums ${
          tone === "emerald" ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** Trim an ESI ISO timestamp to "YYYY-MM-DD HH:MM". */
function fmtDate(iso: string): ReactNode {
  if (!iso) return "—";
  return iso.replace("T", " ").replace("Z", "").slice(0, 16);
}
