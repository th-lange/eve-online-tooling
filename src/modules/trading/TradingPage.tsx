import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DataAge } from "../../components/DataAge";
import {
  CheckboxGroup,
  Field,
  NumField,
  SearchFilterRow,
} from "../../components/forms";
import { toggle, uniqueSorted } from "../../lib/sets";
import {
  errorMessage,
  stationTrading,
  type TradeParams,
  type TradeRow,
} from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import {
  RegionSelect,
  StationSelect,
} from "../../components/RegionStationPicker";
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
import {
  Page,
  PageHeader,
  Centered,
  PrimaryButton,
} from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import { useTypeIdLists } from "../../lib/useSavedLists";
import {
  ListTabs,
  SavedListView,
  RowActionsCell,
  type ListTab,
} from "../../components/typeIdLists";

const FORGE = 10000002;
type Tab = ListTab;

const TITLE = "Station Trading";
const SUBTITLE = "Buy→sell margins at a hub, after broker fee & sales tax.";

export function TradingPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
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

  const regions = useQuery(marketKeys.regions());
  const { favorites, blacklist, toggleFavorite, blacklistRow, remove } =
    useTypeIdLists("trading", setRows, (r) => r.typeId);

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
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
            <PrimaryButton
              onClick={calculate}
              disabled={run.isPending}
              pending={run.isPending}
              pendingLabel="Scanning…"
            >
              Calculate
            </PrimaryButton>
            <DataAge
              updatedAt={run.isSuccess ? run.submittedAt : undefined}
              fetching={run.isPending}
            />
          </>
        }
      />
      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-5">
        <Field label="Region">
          <RegionSelect
            regions={regions.data}
            value={regionId}
            onChange={(id) => {
              setRegionId(id);
              setStationId(null);
            }}
          />
        </Field>
        <Field label="Market">
          <StationSelect
            stations={stations}
            value={stationId}
            onChange={setStationId}
          />
        </Field>
        <NumField
          label="Broker fee %"
          value={brokerPct}
          onChange={setBrokerPct}
        />
        <NumField label="Sales tax %" value={taxPct} onChange={setTaxPct} />
        <div className="self-end pb-1">
          <FeesFromCharacter
            onApply={(b, t) => {
              setBrokerPct(b);
              setTaxPct(t);
            }}
          />
        </div>
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

      <ListTabs
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
              Failed: {errorMessage(run.error)}
            </div>
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
                      onToggle={(v) =>
                        setHideCategories(toggle(hideCategories, v))
                      }
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
                <SearchFilterRow
                  value={search}
                  onChange={setSearch}
                  placeholder="Search name / category / group…"
                  shown={filteredRows.length}
                  total={rows.length}
                />
              )}
              <TradeTable
                rows={filteredRows}
                onFavorite={toggleFavorite}
                onBlacklist={blacklistRow}
              />
            </div>
          ))}

        {tab === "favorites" && (
          <SavedListView
            items={favorites.data ?? []}
            rowsById={rowsByType}
            removeLabel="Unfavorite"
            onRemove={(id) => remove("favorites", id)}
            detail={(r: TradeRow) =>
              `${formatIsk(r.profitPerUnit)}/unit · ${formatPercent(r.margin)}`
            }
          />
        )}
        {tab === "blacklist" && (
          <SavedListView
            items={blacklist.data ?? []}
            rowsById={rowsByType}
            removeLabel="Remove"
            onRemove={(id) => remove("blacklist", id)}
            detail={(r: TradeRow) =>
              `${formatIsk(r.profitPerUnit)}/unit · ${formatPercent(r.margin)}`
            }
          />
        )}
      </div>
    </Page>
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
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item's name.",
  },
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
    description:
      "Buy depth ÷ sell depth — demand vs supply pressure (>1 = more buyers listed).",
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
    description:
      "Sell-side depth ÷ daily-traded — days of supply on the book (lower clears faster).",
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
            <tr
              key={r.typeId}
              className="border-t border-zinc-800 hover:bg-zinc-800/40"
            >
              <RowActionsCell
                row={r}
                onFavorite={onFavorite}
                onBlacklist={onBlacklist}
                showAddToList
              />
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
                <UndercutPrice
                  value={r.buy}
                  tick={0.01}
                  label="buy (overcut +0.01)"
                />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                <UndercutPrice
                  value={r.sell}
                  tick={-0.01}
                  label="sell (undercut −0.01)"
                />
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
