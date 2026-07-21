import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  marketAllRegions,
  marketCurrentLocation,
  marketPrice,
  marketSearchStations,
  marketSellOrders,
  marketOrderBook,
  openMarketWindow,
  sdeSearch,
  systemSearch,
  type HistoryPoint,
  type IdName,
  type PriceModel,
  type SellOrder,
  type OrderBook,
} from "../../lib/api";
import {
  subscribeMarketSearchItem,
  takePendingMarketSearchItem,
} from "../../lib/deepLink";
import {
  SDE_SEARCH_STALE_TIME,
  marketKeys,
  sdeKeys,
} from "../../lib/queryKeys";
import { SEC_HEX, secBand } from "../../lib/security";
import { AddToListButton } from "../../components/AddToListButton";
import { Combo } from "../../components/Combo";
import { PriceHistoryView } from "../../components/PriceHistory";
import { DepthChart } from "../../components/DepthChart";
import {
  MultiRegionHistory,
  type RegionSeries,
} from "../../components/MultiRegionHistory";
import { Stat } from "../../components/Stat";
import {
  formatInt,
  formatIsk,
  formatPercent,
  sortRows,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { Page, PageHeader, Centered } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";

const FORGE = 10000002;

type Tab = "search" | "history";
type Picked = { id: number; name: string } | null;

const TITLE = "Market Search";
const SUBTITLE =
  "Find an item's sell orders across the market, or chart its price & volume history.";

export function MarketSearchPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const [tab, setTab] = useState<Tab>("search");

  // Shared item selection.
  const [picked, setPicked] = useState<Picked>(null);

  // Location filters — region is null for "everywhere".
  const [regionId, setRegionId] = useState<number | null>(FORGE);
  const [system, setSystem] = useState<Picked>(null);
  const [station, setStation] = useState<Picked>(null);

  // Extra regions to overlay on the history chart (comparison).
  const [compareRegionIds, setCompareRegionIds] = useState<number[]>([]);
  const [origin, setOrigin] = useState<Picked>(null);
  const [highSecOnly, setHighSecOnly] = useState(false);
  const [excludeScams, setExcludeScams] = useState(true);

  const regions = useQuery({
    queryKey: ["market", "all-regions"],
    queryFn: marketAllRegions,
  });
  const current = useQuery({
    queryKey: ["market", "current-location"],
    queryFn: marketCurrentLocation,
  });

  // Default the region + jumps origin to the character's current location once.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !current.data) return;
    seeded.current = true;
    setRegionId(current.data.regionId || FORGE);
    setOrigin({ id: current.data.systemId, name: current.data.systemName });
  }, [current.data]);

  // Select an item handed in from elsewhere (e.g. the ⌘K command palette).
  useEffect(() => {
    const apply = (item: { id: number; name: string }) => {
      setPicked({ id: item.id, name: item.name });
      setTab("search");
    };
    const p = takePendingMarketSearchItem();
    if (p) apply(p);
    return subscribeMarketSearchItem(apply);
  }, []);

  const historyRegionId = regionId ?? FORGE;
  const history = useQuery({
    ...marketKeys.history(historyRegionId, picked?.id),
    enabled: tab === "history" && picked != null,
  });
  const compareQueries = useQueries({
    queries: compareRegionIds.map((rid) => ({
      ...marketKeys.history(rid, picked?.id),
      enabled: tab === "history" && picked != null,
    })),
  });
  const price = useQuery({
    queryKey: ["price", historyRegionId, picked?.id],
    queryFn: () => marketPrice(historyRegionId, picked!.id),
    enabled: tab === "history" && picked != null,
  });

  const orders = useQuery({
    queryKey: [
      "sell-orders",
      picked?.id,
      regionId,
      system?.id ?? null,
      station?.id ?? null,
      origin?.id ?? null,
      highSecOnly,
      excludeScams,
    ],
    queryFn: () =>
      marketSellOrders({
        typeId: picked!.id,
        regionId,
        systemId: system?.id ?? null,
        stationId: station?.id ?? null,
        originSystemId: origin?.id ?? null,
        highSecOnly,
        excludeScams,
      }),
    enabled: tab === "search" && picked != null,
  });

  const orderBook = useQuery({
    queryKey: [
      "order-book",
      picked?.id,
      regionId,
      system?.id ?? null,
      station?.id ?? null,
      excludeScams,
    ],
    queryFn: () =>
      marketOrderBook({
        typeId: picked!.id,
        regionId,
        systemId: system?.id ?? null,
        stationId: station?.id ?? null,
        excludeScams,
      }),
    enabled: tab === "search" && picked != null,
  });

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      {/* Item search (shared by both tabs). */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Combo
          label="Item"
          value={picked}
          onPick={setPicked}
          search={sdeSearch}
          queryKey={(text) => sdeKeys.search(text).queryKey}
          staleTime={SDE_SEARCH_STALE_TIME}
          placeholder="search by name…"
          width="w-64"
        />
        {picked && (
          <button
            onClick={() =>
              openMarketWindow(picked.id).catch((e) =>
                alert(`Couldn't open market window: ${errorMessage(e)}`),
              )
            }
            title="Open this item's market in the EVE client (needs a logged-in character + the open-window scope)"
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Open in EVE
          </button>
        )}
        {picked && (
          <AddToListButton
            typeId={picked.id}
            label="Add to list"
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          />
        )}
      </div>

      {/* Tabs. */}
      <div className="mt-5 flex gap-1 border-b border-zinc-800 text-sm">
        <TabButton active={tab === "search"} onClick={() => setTab("search")}>
          Search orders
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          History / Price
        </TabButton>
      </div>

      {tab === "search" ? (
        <SearchTab
          picked={picked}
          regions={regions.data ?? []}
          regionId={regionId}
          setRegionId={setRegionId}
          system={system}
          setSystem={setSystem}
          station={station}
          setStation={setStation}
          origin={origin}
          setOrigin={setOrigin}
          highSecOnly={highSecOnly}
          setHighSecOnly={setHighSecOnly}
          excludeScams={excludeScams}
          setExcludeScams={setExcludeScams}
          orders={orders.data ?? []}
          orderBook={orderBook.data}
          loading={orders.isFetching}
          error={orders.error}
        />
      ) : (
        <HistoryTab
          picked={picked}
          regions={regions.data ?? []}
          regionId={historyRegionId}
          setRegionId={setRegionId}
          price={price.data}
          history={history.data ?? []}
          compareRegionIds={compareRegionIds}
          setCompareRegionIds={setCompareRegionIds}
          compareHistories={compareQueries.map((q) => q.data ?? [])}
          loading={history.isLoading}
        />
      )}
    </Page>
  );
}

// --- Search tab ---

function SearchTab({
  picked,
  regions,
  regionId,
  setRegionId,
  system,
  setSystem,
  station,
  setStation,
  origin,
  setOrigin,
  highSecOnly,
  setHighSecOnly,
  excludeScams,
  setExcludeScams,
  orders,
  orderBook,
  loading,
  error,
}: {
  picked: Picked;
  regions: IdName[];
  regionId: number | null;
  setRegionId: (id: number | null) => void;
  system: Picked;
  setSystem: (v: Picked) => void;
  station: Picked;
  setStation: (v: Picked) => void;
  origin: Picked;
  setOrigin: (v: Picked) => void;
  highSecOnly: boolean;
  setHighSecOnly: (v: boolean) => void;
  excludeScams: boolean;
  setExcludeScams: (v: boolean) => void;
  orders: SellOrder[];
  orderBook: OrderBook | undefined;
  loading: boolean;
  error: unknown;
}) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Region
          <select
            value={regionId == null ? "" : regionId}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setRegionId(v === "" ? null : Number(v));
              // A region change is a coarser filter than system/station; clear them.
              setSystem(null);
              setStation(null);
            }}
            className="w-48 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="">Everywhere (all regions)</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <Combo
          label="System (optional)"
          value={system}
          onPick={(v) => {
            setSystem(v);
            setStation(null);
          }}
          search={systemSearch}
          placeholder="any system…"
        />
        <Combo
          label="Station (optional)"
          value={station}
          onPick={setStation}
          search={marketSearchStations}
          placeholder="any station…"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Combo
          label="Jumps from"
          value={origin}
          onPick={setOrigin}
          search={systemSearch}
          placeholder="origin system…"
        />
        <label className="flex items-center gap-2 pb-1 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={highSecOnly}
            onChange={(e) => setHighSecOnly(e.currentTarget.checked)}
            className="accent-emerald-500"
          />
          High-sec only
        </label>
        <label
          title="Hide sell orders priced above 10× the median (rough scam guard)"
          className="flex items-center gap-2 pb-1 text-xs text-zinc-300"
        >
          <input
            type="checkbox"
            checked={excludeScams}
            onChange={(e) => setExcludeScams(e.currentTarget.checked)}
            className="accent-emerald-500"
          />
          Exclude scams
        </label>
        <span className="pb-1 text-xs text-zinc-500">
          {highSecOnly
            ? "routing avoids low/null-sec"
            : "shortest route, ignores security"}
        </span>
      </div>

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its sell orders.</Centered>
        ) : loading ? (
          <Centered>Loading orders…</Centered>
        ) : error ? (
          <Centered>Couldn't load orders: {errorMessage(error)}</Centered>
        ) : orders.length === 0 ? (
          <Centered>
            No sell orders for this item in the selected area.
          </Centered>
        ) : (
          <div className="flex flex-col gap-4">
            {orderBook &&
              (orderBook.sell.length > 0 || orderBook.buy.length > 0) && (
                <DepthChart sell={orderBook.sell} buy={orderBook.buy} />
              )}
            <OrderTable orders={orders} hasOrigin={origin != null} />
          </div>
        )}
      </div>
    </div>
  );
}

type OrderSortKey =
  | "price"
  | "volumeRemain"
  | "stationName"
  | "systemName"
  | "regionName"
  | "jumps";

const ORDER_SORT_KEYS = [
  "price",
  "volumeRemain",
  "stationName",
  "systemName",
  "regionName",
  "jumps",
] as const;

const ORDER_TEXT_KEYS: OrderSortKey[] = [
  "stationName",
  "systemName",
  "regionName",
];

const ORDER_COLUMNS: SortColumn<OrderSortKey>[] = [
  {
    key: "price",
    label: "Price",
    numeric: true,
    description: "Sell price per unit.",
  },
  {
    key: "volumeRemain",
    label: "Qty",
    numeric: true,
    description: "Units still on offer in this order.",
  },
  {
    key: "stationName",
    label: "Station",
    numeric: false,
    description: "Station (or structure) the order sits at.",
  },
  {
    key: "systemName",
    label: "System",
    numeric: false,
    description: "Solar system, with its security status.",
  },
  {
    key: "regionName",
    label: "Region",
    numeric: false,
    description: "Region the order is in.",
  },
  {
    key: "jumps",
    label: "Jumps",
    numeric: true,
    description:
      "Jumps from your origin to the station (∞ = unreachable with current routing).",
  },
];

function OrderTable({
  orders,
  hasOrigin,
}: {
  orders: SellOrder[];
  hasOrigin: boolean;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<OrderSortKey>(
    "sort.market-search-orders",
    ORDER_SORT_KEYS,
    "price",
    "asc",
    ORDER_TEXT_KEYS,
  );

  const sorted = useMemo(() => {
    if (sortKey === "jumps") {
      // Unreachable / no-origin rows sort to the bottom regardless of dir.
      return sortRows(orders, "jumps", sortDir, { nullsLast: true });
    }
    const dir = sortDir === "asc" ? 1 : -1;
    return [...orders].sort((a, b) => {
      if (ORDER_TEXT_KEYS.includes(sortKey)) {
        return dir * String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      return dir * ((a[sortKey] as number) - (b[sortKey] as number));
    });
  }, [orders, sortKey, sortDir]);

  return (
    <div className="max-h-[28rem] overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-xs">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            {ORDER_COLUMNS.map((c) => (
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
          {sorted.map((o, i) => (
            <tr key={i} className="border-t border-zinc-800/60 text-zinc-300">
              <td className="px-3 py-0.5 text-right tabular-nums text-rose-300">
                {formatIsk(o.price)}
              </td>
              <td className="px-3 py-0.5 text-right tabular-nums">
                {formatInt(o.volumeRemain)}
              </td>
              <td className="px-3 py-0.5">{o.stationName}</td>
              <td className="px-3 py-0.5">
                <SecDot security={o.security} /> {o.systemName}
              </td>
              <td className="px-3 py-0.5 text-zinc-400">{o.regionName}</td>
              <td className="px-3 py-0.5 text-right tabular-nums">
                {!hasOrigin ? "—" : o.jumps == null ? "∞" : o.jumps}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SecDot({ security }: { security: number }) {
  const s = Math.round(security * 10) / 10;
  const color = SEC_HEX[secBand(security)];
  return (
    <span className="tabular-nums" style={{ color }}>
      {s.toFixed(1)}
    </span>
  );
}

// --- History / price tab (the original market explorer) ---

function HistoryTab({
  picked,
  regions,
  regionId,
  setRegionId,
  price,
  history,
  compareRegionIds,
  setCompareRegionIds,
  compareHistories,
  loading,
}: {
  picked: Picked;
  regions: IdName[];
  regionId: number;
  setRegionId: (id: number | null) => void;
  price: PriceModel | undefined;
  history: HistoryPoint[];
  compareRegionIds: number[];
  setCompareRegionIds: (ids: number[]) => void;
  compareHistories: HistoryPoint[][];
  loading: boolean;
}) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Region
          <select
            value={regionId}
            onChange={(e) => setRegionId(Number(e.currentTarget.value))}
            className="w-48 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Compare regions
          <select
            value=""
            onChange={(e) => {
              const id = Number(e.currentTarget.value);
              if (id && !compareRegionIds.includes(id))
                setCompareRegionIds([...compareRegionIds, id]);
            }}
            className="w-48 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="">add a region…</option>
            {regions
              .filter(
                (r) => r.id !== regionId && !compareRegionIds.includes(r.id),
              )
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </label>
        {compareRegionIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pb-1">
            {compareRegionIds.map((id) => (
              <span
                key={id}
                className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
              >
                {regions.find((r) => r.id === id)?.name ?? id}
                <button
                  onClick={() =>
                    setCompareRegionIds(
                      compareRegionIds.filter((x) => x !== id),
                    )
                  }
                  aria-label="Remove region"
                  className="text-zinc-500 hover:text-rose-300"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {picked && price && (
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <Stat
            label="Sell (min)"
            value={formatIsk(price.sellMin)}
            accent="text-rose-300"
          />
          <Stat
            label="Buy (max)"
            value={formatIsk(price.buyMax)}
            accent="text-emerald-300"
          />
          <Stat label="Spread" value={spread(price.sellMin, price.buyMax)} />
          <Stat label="Daily volume" value={formatInt(price.dailyVolume)} />
        </div>
      )}

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its prices and history.</Centered>
        ) : loading ? (
          <Centered>Loading history…</Centered>
        ) : history.length === 0 ? (
          <Centered>No history for this item in this region.</Centered>
        ) : (
          <div className="flex flex-col gap-4">
            <PriceHistoryView history={history} />
            {compareRegionIds.length > 0 && (
              <div>
                <div className="mb-1 text-xs text-zinc-400">
                  Region comparison — daily average
                </div>
                <MultiRegionHistory
                  regions={
                    [
                      {
                        name:
                          regions.find((r) => r.id === regionId)?.name ??
                          "Primary",
                        history,
                      },
                      ...compareRegionIds.map((id, i) => ({
                        name:
                          regions.find((r) => r.id === id)?.name ?? String(id),
                        history: compareHistories[i] ?? [],
                      })),
                    ] satisfies RegionSeries[]
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-1.5 ${
        active
          ? "border-emerald-400 text-zinc-100"
          : "border-transparent text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

function spread(sell?: number | null, buy?: number | null): string {
  if (sell == null || buy == null || sell <= 0) return "—";
  return formatPercent((sell - buy) / sell);
}
