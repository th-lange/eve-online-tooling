import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  lpBalances,
  lpOffers,
  type LpParams,
  type OfferRow,
} from "../../lib/api";
import { QueryErrorNotice } from "../../components/QueryErrorNotice";
import { formatAgo, formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { Field } from "../../components/forms";
import { SdeGate } from "../../components/SdeGate";

type OfferSortKey =
  "name" | "lpCost" | "iskCost" | "sellValue" | "profit" | "iskPerLp";
const OFFER_COLUMNS: SortColumn<OfferSortKey>[] = [
  {
    key: "name",
    label: "Offer",
    numeric: false,
    description: "The item you receive.",
  },
  {
    key: "lpCost",
    label: "LP",
    numeric: true,
    description: "Loyalty points required.",
  },
  {
    key: "iskCost",
    label: "ISK cost",
    numeric: true,
    description: "ISK the offer also costs.",
  },
  {
    key: "sellValue",
    label: "Sell value",
    numeric: true,
    description: "Jita sell value of the item(s), less ~5%.",
  },
  {
    key: "profit",
    label: "Profit",
    numeric: true,
    description: "Sell value − cost (LP×rate + ISK + handed-in items).",
  },
  {
    key: "iskPerLp",
    label: "ISK/LP",
    numeric: true,
    description: "Net ISK per loyalty point.",
  },
];
const OFFER_KEYS = OFFER_COLUMNS.map((c) => c.key);

const TITLE = "LP store";
const SUBTITLE = "Loyalty-store offers ranked by ISK per LP, valued at Jita.";

export function LpStorePage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const [corpId, setCorpId] = useState<number | null>(null);
  const [iskPerLp, setIskPerLp] = useState(1000);
  const [rows, setRows] = useState<OfferRow[]>([]);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  const balances = useQuery({
    queryKey: ["lp", "balances"],
    queryFn: lpBalances,
  });
  const run = useMutation({
    mutationFn: (p: LpParams) => lpOffers(p),
    onSuccess: (r) => {
      setRows(r.rows);
      setFetchedAt(r.fetchedAt);
    },
  });

  useEffect(() => {
    if (corpId == null && balances.data && balances.data.length > 0) {
      setCorpId(balances.data[0].corporationId);
    }
  }, [balances.data, corpId]);

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
            {fetchedAt != null && (
              <span className="text-xs text-zinc-500">
                Offers pulled {formatAgo(fetchedAt * 1000)}
              </span>
            )}
            <div className="flex items-center gap-2">
              <PrimaryButton
                onClick={() =>
                  corpId != null &&
                  run.mutate({ corporationId: corpId, iskPerLp })
                }
                disabled={run.isPending || corpId == null}
                pending={run.isPending}
                pendingLabel="Pricing…"
              >
                Calculate
              </PrimaryButton>
              <button
                onClick={() =>
                  corpId != null &&
                  run.mutate({
                    corporationId: corpId,
                    iskPerLp,
                    refresh: true,
                  })
                }
                disabled={run.isPending || corpId == null}
                title="Re-pull the offers from ESI (ignore the local cache)"
                className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
          </>
        }
      />

      <QueryErrorNotice
        error={balances.error}
        loginMessage="Log in a character first to view loyalty-point balances."
        scopeHint="check the loyalty scope is enabled."
      />

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Corporation (your LP)">
          <select
            value={corpId ?? ""}
            onChange={(e) => setCorpId(Number(e.currentTarget.value))}
            className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {balances.data?.map((b) => (
              <option key={b.corporationId} value={b.corporationId}>
                {b.corporation} — {formatInt(b.points)} LP
              </option>
            ))}
          </select>
        </Field>
        <Field label="ISK per LP">
          <input
            type="number"
            value={iskPerLp}
            onChange={(e) => setIskPerLp(Number(e.currentTarget.value))}
            className="w-28 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
      </div>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(run.error)}
        </div>
      )}

      <OfferTable rows={rows} />
    </Page>
  );
}

function OfferTable({ rows }: { rows: OfferRow[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<OfferSortKey>(
    "sort.lpstore",
    OFFER_KEYS,
    "iskPerLp",
    "desc",
    ["name"],
  );
  const sorted = sortRows(rows, sortKey, sortDir);
  return (
    <>
      <div className="mt-4 overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              {OFFER_COLUMNS.map((c) => (
                <SortHeaderCell
                  key={c.key}
                  column={c}
                  active={sortKey === c.key}
                  dir={sortDir}
                  onClick={toggleSort}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">
                  {r.quantity > 1 ? `${formatInt(r.quantity)}× ` : ""}
                  {r.name}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {formatInt(r.lpCost)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {formatIsk(r.iskCost)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                  {formatIsk(r.sellValue)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${
                    r.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {formatIsk(r.profit)}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${
                    r.iskPerLp >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {formatIsk(r.iskPerLp)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  Pick a corporation and Calculate.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        Blueprint offers value the BPC item itself (not the built product) — a
        known under-valuation.
      </div>
    </>
  );
}
