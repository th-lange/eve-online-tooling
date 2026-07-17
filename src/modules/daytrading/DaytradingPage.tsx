import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataAge } from "../../components/DataAge";
import { AddToListButton } from "../../components/AddToListButton";
import {
  daytradingGetList,
  daytradingScan,
  daytradingSetList,
  marketRegions,
  rosterStock,
  sdeMarketCategories,
  sdeStatus,
  type DayTradeParams,
  type DayTradeRow,
  type ListName,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import {
  formatInt,
  formatIsk,
  formatPercent,
  sortRows,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { FeesFromCharacter } from "../../components/FeesFromCharacter";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader, SplitPane, Centered } from "../../components/page";

type Tab = "opportunities" | "favorites" | "blacklist";

/** EVE category ids for the default day-trade set: Ship / Module / Charge. */
const DEFAULT_CATEGORY_IDS = [6, 7, 8];

const TITLE = "Daytrading";
const SUBTITLE =
  "Short-term flips across regions — scans hubs for price gaps on the same item, ranked by ISK/m³.";

export function DaytradingPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) {
    return (
      <Page>
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <Centered>Checking static data…</Centered>
      </Page>
    );
  }
  if (!status.data?.installed) {
    return (
      <Page>
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SdeSetup onInstalled={() => status.refetch()} />
      </Page>
    );
  }
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("opportunities");
  // Empty = all hubs; otherwise the explicit subset to compare.
  const [regionIds, setRegionIds] = useState<Set<number>>(new Set());
  const [brokerPct, setBrokerPct] = useState(3);
  const [taxPct, setTaxPct] = useState(4.5);
  const [shippingRate, setShippingRate] = useState(1000);
  const [purchaseDays, setPurchaseDays] = useState(1);
  const [minProfit, setMinProfit] = useState("100000");
  const [minDailyDemand, setMinDailyDemand] = useState("0");
  // Net owned stock off the suggested quantity (default on) — don't restock the
  // hangar. Fetched lazily; only when the toggle is on.
  const [subtractStock, setSubtractStock] = useState(true);
  const [search, setSearch] = useState("");
  // Category whitelist (pre-scan): only these categories are pulled/priced at
  // each hub. Defaults to the common day-trade set (Ships/Modules/Charges).
  const [categoryIds, setCategoryIds] = useState<Set<number>>(
    new Set(DEFAULT_CATEGORY_IDS),
  );
  // Post-scan tech-level exclusion: check a tech level to *hide* it from results.
  const [hideMetas, setHideMetas] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<DayTradeRow[]>([]);

  const regions = useQuery({
    queryKey: ["market", "regions"],
    queryFn: marketRegions,
  });
  const categories = useQuery({
    queryKey: ["sde", "marketCategories"],
    queryFn: sdeMarketCategories,
  });
  const stock = useQuery({
    queryKey: ["roster", "stock"],
    queryFn: rosterStock,
    enabled: subtractStock,
  });
  const favorites = useQuery({
    queryKey: ["daytrading", "favorites"],
    queryFn: () => daytradingGetList("favorites"),
  });
  const blacklist = useQuery({
    queryKey: ["daytrading", "blacklist"],
    queryFn: () => daytradingGetList("blacklist"),
  });

  const run = useMutation({
    mutationFn: (p: DayTradeParams) => daytradingScan(p),
    onSuccess: setRows,
  });

  function calculate() {
    run.mutate({
      regionIds: [...regionIds],
      salesTax: taxPct / 100,
      brokerFee: brokerPct / 100,
      shippingRate,
      purchaseDays,
      minProfit: minProfit.trim() === "" ? 0 : Number(minProfit),
      minDailyDemand: minDailyDemand.trim() === "" ? 0 : Number(minDailyDemand),
      categoryIds: [...categoryIds],
      stock: subtractStock ? (stock.data ?? {}) : {},
    });
  }

  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      daytradingSetList(v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: ["daytrading", v.list] }),
  });

  function toggleFavorite(r: DayTradeRow) {
    setList.mutate({ list: "favorites", typeId: r.typeId, add: !r.favorite });
    setRows((prev) =>
      prev.map((x) =>
        x.typeId === r.typeId ? { ...x, favorite: !x.favorite } : x,
      ),
    );
  }
  function blacklistRow(r: DayTradeRow) {
    setList.mutate({ list: "blacklist", typeId: r.typeId, add: true });
    setRows((prev) => prev.filter((x) => x.typeId !== r.typeId));
  }

  const allRegions = regions.data ?? [];
  const selectedCount =
    regionIds.size === 0 ? allRegions.length : regionIds.size;
  const allCategories = categories.data ?? [];
  const rowsByType = useMemo(
    () => new Map(rows.map((r) => [r.typeId, r])),
    [rows],
  );
  const metaOptions = useMemo(
    () => uniqueSorted(rows, (r) => r.metaGroup),
    [rows],
  );
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.metaGroup && hideMetas.has(r.metaGroup)) return false;
      if (
        q &&
        ![r.name, r.category, r.group, r.buyHub, r.sellHub]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [rows, search, hideMetas]);

  function toggleRegion(id: number) {
    setRegionIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleCategory(id: number) {
    setCategoryIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
            <button
              onClick={calculate}
              disabled={
                run.isPending || selectedCount < 2 || categoryIds.size === 0
              }
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              title={
                selectedCount < 2
                  ? "Select at least two hubs"
                  : categoryIds.size === 0
                    ? "Select at least one category"
                    : undefined
              }
            >
              {run.isPending ? "Scanning…" : "Calculate"}
            </button>
            <DataAge
              updatedAt={run.isSuccess ? run.submittedAt : undefined}
              fetching={run.isPending}
            />
          </>
        }
      />

      <SplitPane
        left={
          <>
            <Field label={`Hubs to compare (${selectedCount})`}>
              <div className="flex flex-wrap gap-1">
                {allRegions.map((r) => {
                  const on = regionIds.size === 0 || regionIds.has(r.id);
                  return (
                    <label
                      key={r.id}
                      className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs ${
                        on
                          ? "bg-zinc-700 text-zinc-100"
                          : "bg-zinc-800 text-zinc-400"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={regionIds.has(r.id)}
                        onChange={() => toggleRegion(r.id)}
                      />
                      {r.name}
                    </label>
                  );
                })}
              </div>
              <span className="mt-1 text-[11px] text-zinc-500">
                None checked = all hubs.
              </span>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <NumField
                label="Broker fee %"
                value={brokerPct}
                onChange={setBrokerPct}
              />
              <NumField
                label="Sales tax %"
                value={taxPct}
                onChange={setTaxPct}
              />
              <div className="col-span-2">
                <FeesFromCharacter
                  onApply={(b, t) => {
                    setBrokerPct(b);
                    setTaxPct(t);
                  }}
                />
              </div>
              <NumField
                label="Shipping ISK/m³"
                value={shippingRate}
                onChange={setShippingRate}
              />
              <NumField
                label="Stock days"
                value={purchaseDays}
                onChange={setPurchaseDays}
              />
              <Field label="Min profit/unit">
                <input
                  type="number"
                  value={minProfit}
                  min={0}
                  onChange={(e) => setMinProfit(e.currentTarget.value)}
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <Field label="Min sell-hub vol/day">
                <input
                  type="number"
                  value={minDailyDemand}
                  min={0}
                  onChange={(e) => setMinDailyDemand(e.currentTarget.value)}
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                />
              </Field>
              <Field label="Owned stock">
                <label className="flex cursor-pointer items-center gap-2 py-1 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={subtractStock}
                    onChange={(e) => setSubtractStock(e.currentTarget.checked)}
                  />
                  Subtract from qty{stock.isFetching ? " (loading…)" : ""}
                </label>
              </Field>
            </div>
          </>
        }
        right={
          <Field label={`Categories to scan (${categoryIds.size})`}>
            <div className="flex max-h-64 flex-wrap gap-1 overflow-auto">
              {allCategories.map((c) => {
                const on = categoryIds.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs ${
                      on
                        ? "bg-zinc-700 text-zinc-100"
                        : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleCategory(c.id)}
                    />
                    {c.name}
                  </label>
                );
              })}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => setCategoryIds(new Set(DEFAULT_CATEGORY_IDS))}
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
              >
                Ships + Modules + Charges
              </button>
              <button
                type="button"
                onClick={() =>
                  setCategoryIds(new Set(allCategories.map((c) => c.id)))
                }
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setCategoryIds(new Set())}
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
              >
                Clear
              </button>
              <span className="text-zinc-500">
                Only the chosen categories are pulled — fewer = faster.
              </span>
            </div>
          </Field>
        }
      />

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
            <div className="text-sm text-rose-400">
              Failed: {String(run.error)}
            </div>
          ) : run.isPending ? (
            <Centered>
              Pricing {categoryIds.size} categor
              {categoryIds.size === 1 ? "y" : "ies"} across {selectedCount}{" "}
              hubs…
            </Centered>
          ) : (
            <div>
              {rows.length > 0 && metaOptions.length > 0 && (
                <div className="mb-2">
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
                    placeholder="Search name / category / hub…"
                    className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                  />
                  <span className="text-xs text-zinc-500">
                    {filteredRows.length} of {rows.length} shown
                  </span>
                </div>
              )}
              <DayTradeTable
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
    </Page>
  );
}

type DaySortKey =
  | "name"
  | "buyPrice"
  | "sellPrice"
  | "profitPerUnit"
  | "margin"
  | "iskPerM3"
  | "totalProfit"
  | "suggestedQty"
  | "volumeM3"
  | "destVolume"
  | "daysOfSupply";

const DAY_COLUMNS: SortColumn<DaySortKey>[] = [
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item, with its best buy→sell route below.",
  },
  {
    key: "buyPrice",
    label: "Buy",
    numeric: true,
    description:
      "Acquisition price at the cheapest hub (realistic sell price you buy off).",
  },
  {
    key: "sellPrice",
    label: "Sell",
    numeric: true,
    description:
      "Sale price at the dearest hub (realistic sell price you relist at).",
  },
  {
    key: "profitPerUnit",
    label: "Profit/unit",
    numeric: true,
    description: "Net ISK per unit after sales tax + broker fee.",
  },
  {
    key: "margin",
    label: "Margin",
    numeric: true,
    description: "Profit ÷ acquisition cost.",
  },
  {
    key: "iskPerM3",
    label: "ISK/m³",
    numeric: true,
    description:
      "Profit per m³ of cargo — the metric a hauler optimizes (cargo-bound).",
  },
  {
    key: "totalProfit",
    label: "Total",
    numeric: true,
    description:
      "Profit at the suggested quantity (profit/unit × suggested qty).",
  },
  {
    key: "suggestedQty",
    label: "Qty",
    numeric: true,
    description: "Units worth buying = sell-hub daily volume × stock days.",
  },
  {
    key: "volumeM3",
    label: "m³",
    numeric: true,
    description: "Packaged volume per unit.",
  },
  {
    key: "destVolume",
    label: "Sell vol",
    numeric: true,
    description:
      "Average units traded per day at the sell hub — how much you can offload.",
  },
  {
    key: "daysOfSupply",
    label: "Supply",
    numeric: true,
    description:
      "Sell-hub order-book supply ÷ daily-traded — lower clears faster.",
  },
];

const DAY_SORT_KEYS = DAY_COLUMNS.map((c) => c.key);

function DayTradeTable({
  rows,
  onFavorite,
  onBlacklist,
}: {
  rows: DayTradeRow[];
  onFavorite: (r: DayTradeRow) => void;
  onBlacklist: (r: DayTradeRow) => void;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<DaySortKey>(
    "sort.daytrading",
    DAY_SORT_KEYS,
    "iskPerM3",
    "desc",
    ["name"],
  );

  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir),
    [rows, sortKey, sortDir],
  );

  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="w-16" />
            {DAY_COLUMNS.map((c) => (
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
            <tr
              key={r.typeId}
              className="border-t border-zinc-800 hover:bg-zinc-800/40"
            >
              <td className="px-2">
                <button
                  onClick={() => onFavorite(r)}
                  title="Favorite"
                  className={
                    r.favorite
                      ? "text-amber-400"
                      : "text-zinc-600 hover:text-amber-400"
                  }
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
                <div className="text-zinc-200">{r.name}</div>
                <div className="text-xs text-zinc-500">
                  <span className="text-sky-400/80">
                    {r.buyHub} → {r.sellHub}
                  </span>
                  {(r.category || r.group) &&
                    ` · ${[r.category, r.group].filter(Boolean).join(" · ")}`}
                </div>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.buyPrice)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.sellPrice)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                {formatIsk(r.profitPerUnit)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatPercent(r.margin)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">
                {formatIsk(r.iskPerM3)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                {formatIsk(r.totalProfit)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.suggestedQty)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.volumeM3.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.destVolume)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.daysOfSupply.toLocaleString(undefined, {
                  maximumFractionDigits: 1,
                })}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} className="px-3 py-6 text-center text-zinc-500">
                Hit Calculate to scan for cross-region flips.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function uniqueSorted(
  rows: DayTradeRow[],
  pick: (r: DayTradeRow) => string | null,
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
  rowsByType: Map<number, DayTradeRow>;
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
                  {r
                    ? `${r.buyHub} → ${r.sellHub} · ${formatIsk(r.iskPerM3)}/m³`
                    : ""}
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
