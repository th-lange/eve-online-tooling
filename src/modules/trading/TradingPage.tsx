import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataAge } from "../../components/DataAge";
import { AddToListButton } from "../../components/AddToListButton";
import {
  marketRegions,
  sdeStatus,
  stationTrading,
  tradingGetList,
  tradingSetList,
  type ListName,
  type TradeParams,
  type TradeRow,
} from "../../lib/api";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt, formatIsk, formatPercent } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";

const FORGE = 10000002;
type Tab = "opportunities" | "favorites" | "blacklist";

export function TradingPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("opportunities");
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(60003760); // Jita
  const [brokerPct, setBrokerPct] = useState(3);
  const [taxPct, setTaxPct] = useState(4.5);
  const [minVolume, setMinVolume] = useState("1000");
  const [search, setSearch] = useState("");
  // Exclusion filters: nothing checked = show everything; check a category or
  // tech level to *hide* it (e.g. blueprints, SKINs, apparel, faction).
  const [hideCategories, setHideCategories] = useState<Set<string>>(new Set());
  const [hideMetas, setHideMetas] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<TradeRow[]>([]);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const favorites = useQuery({
    queryKey: ["trading", "favorites"],
    queryFn: () => tradingGetList("favorites"),
  });
  const blacklist = useQuery({
    queryKey: ["trading", "blacklist"],
    queryFn: () => tradingGetList("blacklist"),
  });

  const run = useMutation({
    mutationFn: (p: TradeParams) => stationTrading(p),
    onSuccess: setRows,
  });

  function calculate() {
    run.mutate({
      regionId,
      stationId,
      brokerFee: brokerPct / 100,
      salesTax: taxPct / 100,
      minVolume: minVolume.trim() === "" ? 0 : Number(minVolume),
    });
  }

  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      tradingSetList(v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: ["trading", v.list] }),
  });

  function toggleFavorite(r: TradeRow) {
    setList.mutate({ list: "favorites", typeId: r.typeId, add: !r.favorite });
    setRows((prev) =>
      prev.map((x) =>
        x.typeId === r.typeId ? { ...x, favorite: !x.favorite } : x,
      ),
    );
  }
  function blacklistRow(r: TradeRow) {
    setList.mutate({ list: "blacklist", typeId: r.typeId, add: true });
    setRows((prev) => prev.filter((x) => x.typeId !== r.typeId));
  }

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rowsByType = useMemo(
    () => new Map(rows.map((r) => [r.typeId, r])),
    [rows],
  );
  const categoryOptions = useMemo(
    () => uniqueSorted(rows, (r) => r.category),
    [rows],
  );
  const metaOptions = useMemo(
    () => uniqueSorted(rows, (r) => r.metaGroup),
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.category && hideCategories.has(r.category)) return false;
      if (r.metaGroup && hideMetas.has(r.metaGroup)) return false;
      if (
        q &&
        ![r.name, r.category, r.group, r.metaGroup]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [rows, search, hideCategories, hideMetas]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Station Trading
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Buy→sell margins at a hub, after broker fee &amp; sales tax.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={calculate}
            disabled={run.isPending}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {run.isPending ? "Scanning…" : "Calculate"}
          </button>
          <DataAge
            updatedAt={run.isSuccess ? run.submittedAt : undefined}
            fetching={run.isPending}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-5">
        <Field label="Region">
          <select
            value={regionId}
            onChange={(e) => {
              setRegionId(Number(e.currentTarget.value));
              setStationId(null);
            }}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {regions.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Market">
          <select
            value={stationId ?? ""}
            onChange={(e) =>
              setStationId(
                e.currentTarget.value === ""
                  ? null
                  : Number(e.currentTarget.value),
              )
            }
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="">Region average</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <NumField label="Broker fee %" value={brokerPct} onChange={setBrokerPct} />
        <NumField label="Sales tax %" value={taxPct} onChange={setTaxPct} />
        <Field label="Min volume">
          <input
            type="number"
            value={minVolume}
            min={0}
            onChange={(e) => setMinVolume(e.currentTarget.value)}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
      </div>

      <Tabs
        tab={tab}
        onChange={setTab}
        counts={{
          favorites: favorites.data?.length ?? 0,
          blacklist: blacklist.data?.length ?? 0,
        }}
      />

      <div className="mt-3">
        {tab === "opportunities" &&
          (run.isError ? (
            <ErrorMsg e={run.error} />
          ) : run.isPending ? (
            <Centered>Scanning ~19k items at the chosen market…</Centered>
          ) : (
            <div>
              {rows.length > 0 && (
                <div className="mb-2 grid gap-3 md:grid-cols-2">
                  <Field label="Hide categories (check to exclude)">
                    <CheckboxGroup
                      options={categoryOptions}
                      selected={hideCategories}
                      onToggle={(v) => setHideCategories(toggle(hideCategories, v))}
                    />
                  </Field>
                  <Field label="Hide tech levels (check to exclude)">
                    <CheckboxGroup
                      options={metaOptions}
                      selected={hideMetas}
                      onToggle={(v) => setHideMetas(toggle(hideMetas, v))}
                    />
                  </Field>
                </div>
              )}
              {rows.length > 0 && (
                <div className="mb-2 flex items-center gap-3">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    placeholder="Search name / category / group…"
                    className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  />
                  <span className="text-xs text-zinc-500">
                    {filteredRows.length} of {rows.length} shown
                  </span>
                </div>
              )}
              <TradeTable
                rows={filteredRows}
                onFavorite={toggleFavorite}
                onBlacklist={blacklistRow}
              />
            </div>
          ))}

        {tab === "favorites" && (
          <ListView
            items={favorites.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Unfavorite"
            onRemove={(id) =>
              setList.mutate({ list: "favorites", typeId: id, add: false })
            }
          />
        )}
        {tab === "blacklist" && (
          <ListView
            items={blacklist.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Remove"
            onRemove={(id) =>
              setList.mutate({ list: "blacklist", typeId: id, add: false })
            }
          />
        )}
      </div>
    </div>
  );
}

type TradeSortKey =
  | "name"
  | "buy"
  | "sell"
  | "profitPerUnit"
  | "margin"
  | "volume"
  | "buyVolume"
  | "buySellRatio"
  | "dailyTraded"
  | "daysOfSupply";

const TRADE_COLUMNS: SortColumn<TradeSortKey>[] = [
  { key: "name", label: "Item", numeric: false, description: "The item's name." },
  {
    key: "buy",
    label: "Buy",
    numeric: true,
    description: "Buy-order price at the chosen basis — what you acquire at.",
  },
  {
    key: "sell",
    label: "Sell",
    numeric: true,
    description: "Sell-order price at the chosen basis — what you sell at.",
  },
  {
    key: "profitPerUnit",
    label: "Profit/unit",
    numeric: true,
    description: "Net ISK per unit after broker fee and sales tax.",
  },
  {
    key: "margin",
    label: "Margin",
    numeric: true,
    description: "Profit ÷ cost.",
  },
  {
    key: "volume",
    label: "Sell vol",
    numeric: true,
    description: "Units currently listed in sell orders — sell-side depth.",
  },
  {
    key: "buyVolume",
    label: "Buy vol",
    numeric: true,
    description: "Units currently listed in buy orders — buy-side depth.",
  },
  {
    key: "buySellRatio",
    label: "B/S",
    numeric: true,
    description: "Buy depth ÷ sell depth — demand vs supply pressure (>1 = more buyers listed).",
  },
  {
    key: "dailyTraded",
    label: "Traded/day",
    numeric: true,
    description:
      "Average units traded per day, from market history. Buys and sells are the same quantity (every trade is both), so it isn't split.",
  },
  {
    key: "daysOfSupply",
    label: "Supply",
    numeric: true,
    description: "Sell-side depth ÷ daily-traded — days of supply on the book (lower clears faster).",
  },
];

const TRADE_SORT_KEYS = TRADE_COLUMNS.map((c) => c.key);

function TradeTable({
  rows,
  onFavorite,
  onBlacklist,
}: {
  rows: TradeRow[];
  onFavorite: (r: TradeRow) => void;
  onBlacklist: (r: TradeRow) => void;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<TradeSortKey>(
    "sort.trading",
    TRADE_SORT_KEYS,
    "profitPerUnit",
    "desc",
    ["name"],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      return dir * (a[sortKey] - b[sortKey]);
    });
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="w-16" />
            {TRADE_COLUMNS.map((c) => (
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
          {sorted.map((r) => (
            <tr key={r.typeId} className="border-t border-zinc-800 hover:bg-zinc-800/40">
              <td className="px-2">
                <button
                  onClick={() => onFavorite(r)}
                  title="Favorite"
                  className={r.favorite ? "text-amber-400" : "text-zinc-600 hover:text-amber-400"}
                >
                  ★
                </button>
                <button
                  onClick={() => onBlacklist(r)}
                  title="Blacklist"
                  className="ml-2 text-zinc-600 hover:text-rose-400"
                >
                  ✕
                </button>
                <span className="ml-2">
                  <AddToListButton
                    typeId={r.typeId}
                    label="+List"
                    className="text-zinc-600 hover:text-emerald-400"
                  />
                </span>
              </td>
              <td className="px-3 py-1.5">
                <div className="text-zinc-200">
                  {r.name}
                  {r.priceFlag && (
                    <span
                      className="ml-1 text-amber-400"
                      title={`Current sell price is ${r.priceFlag} — possible mean-reversion`}
                    >
                      ⚠
                    </span>
                  )}
                </div>
                {(r.category || r.group) && (
                  <div className="text-xs text-zinc-500">
                    {[r.category, r.group].filter(Boolean).join(" · ")}
                  </div>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                <UndercutPrice value={r.buy} tick={0.01} label="buy (overcut +0.01)" />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                <UndercutPrice value={r.sell} tick={-0.01} label="sell (undercut −0.01)" />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                {formatIsk(r.profitPerUnit)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatPercent(r.margin)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.volume)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.buyVolume)}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  r.buySellRatio >= 1 ? "text-emerald-400" : "text-zinc-400"
                }`}
              >
                {r.buySellRatio > 0
                  ? r.buySellRatio.toLocaleString(undefined, {
                      maximumFractionDigits: 2,
                    })
                  : "—"}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatInt(r.dailyTraded)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.daysOfSupply > 0
                  ? r.daysOfSupply.toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })
                  : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={11} className="px-3 py-6 text-center text-zinc-500">
                Hit Calculate to scan the market.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A price that copies an undercut/overcut value (one tick) to the clipboard. */
function UndercutPrice({
  value,
  tick,
  label,
}: {
  value: number;
  tick: number;
  label: string;
}) {
  const adjusted = Math.max(value + tick, 0);
  return (
    <button
      onClick={() => copyToClipboard(adjusted.toFixed(2))}
      title={`Copy ${label}: ${adjusted.toFixed(2)}`}
      className="hover:text-zinc-100"
    >
      {formatIsk(value)}
    </button>
  );
}

function uniqueSorted(
  rows: TradeRow[],
  pick: (r: TradeRow) => string | null,
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (v) set.add(v);
  }
  return [...set].sort();
}

function toggle(set: Set<string>, v: string): Set<string> {
  const next = new Set(set);
  next.has(v) ? next.delete(v) : next.add(v);
  return next;
}

function CheckboxGroup({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) {
    return <div className="text-xs text-zinc-600">—</div>;
  }
  return (
    <div className="flex max-h-28 flex-wrap gap-1 overflow-auto">
      {options.map((o) => (
        <label
          key={o}
          className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs ${
            selected.has(o)
              ? "bg-zinc-700 text-zinc-100"
              : "bg-zinc-800 text-zinc-400"
          }`}
        >
          <input
            type="checkbox"
            checked={selected.has(o)}
            onChange={() => onToggle(o)}
          />
          {o}
        </label>
      ))}
    </div>
  );
}

function ListView({
  items,
  rowsByType,
  removeLabel,
  onRemove,
}: {
  items: { typeId: number; name: string }[];
  rowsByType: Map<number, TradeRow>;
  removeLabel: string;
  onRemove: (typeId: number) => void;
}) {
  if (items.length === 0) {
    return <Centered>Nothing here yet.</Centered>;
  }
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {items.map((it) => {
            const r = rowsByType.get(it.typeId);
            return (
              <tr key={it.typeId} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">{it.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {r ? `${formatIsk(r.profitPerUnit)}/unit · ${formatPercent(r.margin)}` : ""}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => onRemove(it.typeId)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {removeLabel}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Tabs({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: { favorites: number; blacklist: number };
}) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "opportunities", label: "Opportunities" },
    { value: "favorites", label: `Favorites (${counts.favorites})` },
    { value: "blacklist", label: `Blacklist (${counts.blacklist})` },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={0}
        step={0.1}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

function ErrorMsg({ e }: { e: unknown }) {
  return <div className="text-sm text-rose-400">Failed: {String(e)}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}
