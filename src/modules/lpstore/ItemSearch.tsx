import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  errorMessage,
  lpSearch,
  type LpSearchResult,
  type LpSearchRow,
} from "../../lib/api";
import { DataTable, type SortColumn } from "../../components/DataTable";
import {
  formatAgo,
  formatInt,
  formatIsk,
  formatSignedIsk,
  sortRows,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { Field } from "../../components/forms";
import { PrimaryButton } from "../../components/page";

type SearchSortKey =
  | "corporation"
  | "name"
  | "lpCost"
  | "iskCost"
  | "sellValue"
  | "profit"
  | "iskPerLp";
const SEARCH_COLUMNS: SortColumn<SearchSortKey>[] = [
  {
    key: "corporation",
    label: "Corporation",
    numeric: false,
    description: "The NPC corporation whose loyalty store sells this offer.",
  },
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
const SEARCH_KEYS = SEARCH_COLUMNS.map((c) => c.key);

/** "Find item" tab: search every NPC corp's LP store for an item — who offers
 *  it and for how much LP/ISK/turn-ins, valued at Jita like the corp view.
 *  Per-corp offers are cached on disk, so only the first scan walks all of
 *  ESI's ~280 NPC corps. */
export function ItemSearch() {
  const [query, setQuery] = useState("");
  const [iskPerLp, setIskPerLp] = useState(1000);
  const [result, setResult] = useState<LpSearchResult | null>(null);
  const run = useMutation({
    mutationFn: lpSearch,
    onSuccess: setResult,
  });

  const search = (refresh: boolean) => {
    if (query.trim() === "") return;
    run.mutate({ query, iskPerLp, refresh });
  };

  return (
    <>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          search(false);
        }}
      >
        <Field label="Item">
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="e.g. Republic Fleet 100MN Afterburner"
            className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            aria-label="Item to search for"
          />
        </Field>
        <Field label="ISK per LP">
          <input
            type="number"
            value={iskPerLp}
            onChange={(e) => setIskPerLp(Number(e.currentTarget.value))}
            className="w-28 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
        <PrimaryButton
          onClick={() => search(false)}
          disabled={run.isPending || query.trim() === ""}
          pending={run.isPending}
          pendingLabel="Scanning stores…"
        >
          Search
        </PrimaryButton>
        <button
          type="button"
          onClick={() => search(true)}
          disabled={run.isPending || query.trim() === ""}
          title="Re-pull every corp's offers from ESI (ignore the local cache)"
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          Rescan
        </button>
        {result != null && (
          <span className="pb-1.5 text-xs text-zinc-500">
            Store offers as old as {formatAgo(result.oldestFetchedAt * 1000)}
          </span>
        )}
      </form>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(run.error)}
        </div>
      )}
      {result != null && result.failedCorporations > 0 && (
        <div className="mt-3 text-sm text-amber-400">
          ⚠ {result.failedCorporations} corporation
          {result.failedCorporations === 1 ? "'s store" : "s' stores"} couldn't
          be fetched — results may be incomplete. Try Rescan.
        </div>
      )}

      <SearchTable
        rows={result?.rows ?? []}
        searched={result != null && !run.isPending}
      />
      <div className="mt-1 text-xs text-zinc-500">
        Searches every NPC corporation's loyalty store. The first scan downloads
        all of them (a few hundred small requests); later searches reuse the
        local cache.
      </div>
    </>
  );
}

function SearchTable({
  rows,
  searched,
}: {
  rows: LpSearchRow[];
  searched: boolean;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<SearchSortKey>(
    "sort.lpsearch",
    SEARCH_KEYS,
    "lpCost",
    "asc",
    ["corporation", "name"],
  );
  const sorted = sortRows(rows, sortKey, sortDir);
  return (
    <div className="mt-4">
      <DataTable
        columns={SEARCH_COLUMNS}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={toggleSort}
        rows={sorted}
        emptyState={
          <div className="rounded border border-zinc-800 px-3 py-6 text-center text-sm text-zinc-500">
            {searched
              ? "No LP store offers this item."
              : "Enter an item and Search."}
          </div>
        }
        renderRow={(r) => (
          <tr
            key={`${r.corporationId}-${r.name}-${r.lpCost}-${r.iskCost}`}
            className="border-t border-zinc-800 text-zinc-300"
          >
            <td className="px-3 py-1.5">{r.corporation}</td>
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
              {formatSignedIsk(r.profit)}
            </td>
            <td
              className={`px-3 py-1.5 text-right tabular-nums ${
                r.iskPerLp >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {formatSignedIsk(r.iskPerLp)}
            </td>
          </tr>
        )}
      />
    </div>
  );
}
