import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  marketAllRegions,
  marketCurrentLocation,
  marketHistory,
  marketPrice,
  marketSearchStations,
  marketSellOrders,
  openMarketWindow,
  sdeSearch,
  sdeStatus,
  systemSearch,
  type HistoryPoint,
  type IdName,
  type SellOrder,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import {
  subscribeMarketSearchItem,
  takePendingMarketSearchItem,
} from "../../lib/deepLink";
import { AddToListButton } from "../../components/AddToListButton";
import { formatInt, formatIsk } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { SortHeaderCell, type SortColumn } from "../../components/SortHeaderCell";

const FORGE = 10000002;

type Tab = "search" | "history";
type Picked = { id: number; name: string } | null;

export function MarketSearchPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const [tab, setTab] = useState<Tab>("search");

  // Shared item selection.
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Picked>(null);

  // Location filters — region is null for "everywhere".
  const [regionId, setRegionId] = useState<number | null>(FORGE);
  const [system, setSystem] = useState<Picked>(null);
  const [station, setStation] = useState<Picked>(null);

  // Jumps origin + routing preference (search tab).
  const [origin, setOrigin] = useState<Picked>(null);
  const [highSecOnly, setHighSecOnly] = useState(false);

  const [days, setDays] = useState(90);

  const regions = useQuery({ queryKey: ["market", "all-regions"], queryFn: marketAllRegions });
  const current = useQuery({ queryKey: ["market", "current-location"], queryFn: marketCurrentLocation });

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
      setQuery(item.name);
      setTab("search");
    };
    const p = takePendingMarketSearchItem();
    if (p) apply(p);
    return subscribeMarketSearchItem(apply);
  }, []);

  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => sdeSearch(query),
    enabled: query.trim().length >= 2 && !picked,
  });

  const historyRegionId = regionId ?? FORGE;
  const history = useQuery({
    queryKey: ["history", historyRegionId, picked?.id],
    queryFn: () => marketHistory(historyRegionId, picked!.id),
    enabled: tab === "history" && picked != null,
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
    ],
    queryFn: () =>
      marketSellOrders({
        typeId: picked!.id,
        regionId,
        systemId: system?.id ?? null,
        stationId: station?.id ?? null,
        originSystemId: origin?.id ?? null,
        highSecOnly,
      }),
    enabled: tab === "search" && picked != null,
  });

  const series = useMemo(() => (history.data ?? []).slice(-days), [history.data, days]);

  return (
    <div className="p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Market Search</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Find an item's sell orders across the market, or chart its price &amp; volume history.
        </p>
      </div>

      {/* Item search (shared by both tabs). */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="relative">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Item
            <input
              value={picked ? picked.name : query}
              onChange={(e) => {
                setPicked(null);
                setQuery(e.currentTarget.value);
              }}
              placeholder="search by name…"
              className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </label>
          {!picked && (results.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-60 w-64 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg">
              {results.data!.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    setPicked({ id: r.id, name: r.name });
                    setQuery(r.name);
                  }}
                  className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        {picked && (
          <button
            onClick={() =>
              openMarketWindow(picked.id).catch((e) =>
                alert(`Couldn't open market window: ${e}`),
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
          orders={orders.data ?? []}
          loading={orders.isFetching}
          error={orders.error}
        />
      ) : (
        <HistoryTab
          picked={picked}
          regions={regions.data ?? []}
          regionId={historyRegionId}
          setRegionId={setRegionId}
          days={days}
          setDays={setDays}
          price={price.data}
          series={series}
          loading={history.isLoading}
        />
      )}
    </div>
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
  orders,
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
  orders: SellOrder[];
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
        <span className="pb-1 text-xs text-zinc-500">
          {highSecOnly ? "routing avoids low/null-sec" : "shortest route, ignores security"}
        </span>
      </div>

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its sell orders.</Centered>
        ) : loading ? (
          <Centered>Loading orders…</Centered>
        ) : error ? (
          <Centered>Couldn't load orders: {String(error)}</Centered>
        ) : orders.length === 0 ? (
          <Centered>No sell orders for this item in the selected area.</Centered>
        ) : (
          <OrderTable orders={orders} hasOrigin={origin != null} />
        )}
      </div>
    </div>
  );
}

type OrderSortKey = "price" | "volumeRemain" | "stationName" | "systemName" | "regionName" | "jumps";

const ORDER_SORT_KEYS = [
  "price",
  "volumeRemain",
  "stationName",
  "systemName",
  "regionName",
  "jumps",
] as const;

const ORDER_TEXT_KEYS: OrderSortKey[] = ["stationName", "systemName", "regionName"];

const ORDER_COLUMNS: SortColumn<OrderSortKey>[] = [
  { key: "price", label: "Price", numeric: true, description: "Sell price per unit." },
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
  { key: "regionName", label: "Region", numeric: false, description: "Region the order is in." },
  {
    key: "jumps",
    label: "Jumps",
    numeric: true,
    description: "Jumps from your origin to the station (∞ = unreachable with current routing).",
  },
];

function OrderTable({ orders, hasOrigin }: { orders: SellOrder[]; hasOrigin: boolean }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<OrderSortKey>(
    "sort.market-search-orders",
    ORDER_SORT_KEYS,
    "price",
    "asc",
    ORDER_TEXT_KEYS,
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...orders].sort((a, b) => {
      if (ORDER_TEXT_KEYS.includes(sortKey)) {
        return dir * String(a[sortKey]).localeCompare(String(b[sortKey]));
      }
      if (sortKey === "jumps") {
        // Unreachable / no-origin rows sort to the bottom regardless of dir.
        const av = a.jumps ?? Infinity;
        const bv = b.jumps ?? Infinity;
        return dir * (av - bv);
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
              <td className="px-3 py-0.5 text-right tabular-nums">{formatInt(o.volumeRemain)}</td>
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
  const color = s >= 0.5 ? "#34d399" : s > 0.0 ? "#fbbf24" : "#f87171";
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
  days,
  setDays,
  price,
  series,
  loading,
}: {
  picked: Picked;
  regions: IdName[];
  regionId: number;
  setRegionId: (id: number | null) => void;
  days: number;
  setDays: (d: number) => void;
  price: import("../../lib/api").PriceModel | undefined;
  series: HistoryPoint[];
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
          Window
          <select
            value={days}
            onChange={(e) => setDays(Number(e.currentTarget.value))}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={400}>All</option>
          </select>
        </label>
      </div>

      {picked && price && (
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <Stat label="Sell (min)" value={formatIsk(price.sellMin)} accent="text-rose-300" />
          <Stat label="Buy (max)" value={formatIsk(price.buyMax)} accent="text-emerald-300" />
          <Stat label="Spread" value={spread(price.sellMin, price.buyMax)} />
          <Stat label="Daily volume" value={formatInt(price.dailyVolume)} />
        </div>
      )}

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its prices and history.</Centered>
        ) : loading ? (
          <Centered>Loading history…</Centered>
        ) : series.length === 0 ? (
          <Centered>No history for this item in this region.</Centered>
        ) : (
          <HistoryView series={series} />
        )}
      </div>
    </div>
  );
}

// --- Shared pieces ---

/** A searchable combobox over an SDE/region search command, clearable. */
function Combo({
  label,
  value,
  onPick,
  search,
  placeholder,
}: {
  label: string;
  value: Picked;
  onPick: (v: Picked) => void;
  search: (query: string) => Promise<IdName[]>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const results = useQuery({
    queryKey: ["combo", label, text],
    queryFn: () => search(text),
    enabled: text.trim().length >= 2 && value == null,
  });
  return (
    <div className="relative">
      <label className="flex flex-col gap-1 text-xs text-zinc-400">
        {label}
        <div className="flex items-center gap-1">
          <input
            value={value ? value.name : text}
            onChange={(e) => {
              if (value) onPick(null);
              setText(e.currentTarget.value);
            }}
            placeholder={placeholder}
            className="w-52 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {value && (
            <button
              onClick={() => {
                onPick(null);
                setText("");
              }}
              title="Clear"
              className="rounded border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
            >
              ✕
            </button>
          )}
        </div>
      </label>
      {!value && (results.data?.length ?? 0) > 0 && (
        <div className="absolute z-10 mt-1 max-h-60 w-52 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg">
          {results.data!.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onPick({ id: r.id, name: r.name });
                setText(r.name);
              }}
              className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
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
  return `${(((sell - buy) / sell) * 100).toFixed(1)}%`;
}

const MA_PERIODS = [7, 20, 50, 90] as const;

function HistoryView({ series }: { series: HistoryPoint[] }) {
  const [period, setPeriod] = useState(20);
  const [showChannel, setShowChannel] = useState(true);
  const [showMa, setShowMa] = useState(true);
  const [showMedian, setShowMedian] = useState(true);

  const last = series[series.length - 1];
  const avgVol = Math.round(series.reduce((s, p) => s + p.volume, 0) / series.length);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Stat label="Latest avg" value={formatIsk(last.average)} />
        <Stat label="Latest median" value={formatIsk(dailyMedian(last))} />
        <Stat label="Latest volume" value={formatInt(last.volume)} />
        <Stat label="Avg volume/day" value={formatInt(avgVol)} />
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-400">
          <label className="flex items-center gap-1">
            Period
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.currentTarget.value))}
              className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            >
              {MA_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {p}d
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showMa}
              onChange={(e) => setShowMa(e.currentTarget.checked)}
              className="accent-amber-500"
            />
            MA
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showChannel}
              onChange={(e) => setShowChannel(e.currentTarget.checked)}
              className="accent-sky-500"
            />
            Donchian
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showMedian}
              onChange={(e) => setShowMedian(e.currentTarget.checked)}
              className="accent-violet-500"
            />
            Median
          </label>
        </div>
      </div>
      <PriceChart
        series={series}
        period={period}
        showChannel={showChannel}
        showMa={showMa}
        showMedian={showMedian}
      />
      <div className="h-3" />
      <Chart
        series={series}
        pick={(p) => p.volume}
        label="Daily volume"
        color="#60a5fa"
        fmt={(v) => formatInt(v)}
      />
      <div className="mt-4 max-h-72 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Date</th>
              <th className="px-2 py-1 text-right font-medium">Avg</th>
              <th className="px-2 py-1 text-right font-medium">Low</th>
              <th className="px-2 py-1 text-right font-medium">High</th>
              <th className="px-2 py-1 text-right font-medium">Volume</th>
              <th className="px-2 py-1 text-right font-medium">Orders</th>
            </tr>
          </thead>
          <tbody>
            {[...series].reverse().map((p) => (
              <tr key={p.date} className="border-t border-zinc-800/60 text-zinc-300">
                <td className="px-2 py-0.5">{p.date}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">{formatIsk(p.average)}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">{formatIsk(p.lowest)}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">{formatIsk(p.highest)}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">{formatInt(p.volume)}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">{formatInt(p.orderCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Simple moving average of `vals` over `period` (uses the available window at
 *  the head so the line spans the whole series). */
function sma(vals: number[], period: number): number[] {
  return vals.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) sum += vals[j];
    return sum / (i - start + 1);
  });
}

/** A day's median price. ESI daily history has no true intraday median, so we
 *  use the midpoint of that day's high/low range (falling back to the day's
 *  average when a high/low is missing). One value per day, not over the window. */
function dailyMedian(p: HistoryPoint): number {
  return p.highest > 0 && p.lowest > 0 ? (p.highest + p.lowest) / 2 : p.average;
}

/** Donchian channel: rolling max of the daily high / min of the daily low over
 *  `period`. Falls back to the day's average when a high/low is missing. */
function donchian(series: HistoryPoint[], period: number): { upper: number[]; lower: number[] } {
  const upper = series.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let m = -Infinity;
    for (let j = start; j <= i; j++) m = Math.max(m, series[j].highest || series[j].average);
    return m;
  });
  const lower = series.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let m = Infinity;
    for (let j = start; j <= i; j++) {
      m = Math.min(m, series[j].lowest > 0 ? series[j].lowest : series[j].average);
    }
    return m;
  });
  return { upper, lower };
}

/** Price chart with a Donchian channel band and a moving-average overlay on top
 *  of the daily average price (no chart dependency). */
function PriceChart({
  series,
  period,
  showChannel,
  showMa,
  showMedian,
}: {
  series: HistoryPoint[];
  period: number;
  showChannel: boolean;
  showMa: boolean;
  showMedian: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 960;
  const h = 320;
  const padX = 8;
  const padY = 10;

  const avg = series.map((p) => p.average);
  const med = series.map(dailyMedian);
  const ma = sma(avg, period);
  const { upper, lower } = donchian(series, period);

  // Scale to fit whatever is shown (the band widens the range when on).
  const highs = showChannel ? upper : showMedian ? avg.map((v, i) => Math.max(v, med[i])) : avg;
  const lows = showChannel ? lower : showMedian ? avg.map((v, i) => Math.min(v, med[i])) : avg;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;
  const x = (i: number) => padX + (i / Math.max(series.length - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - 2 * padY);
  const line = (vals: number[]) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  // Band = upper across, then lower back (a closed polygon).
  const band = [
    ...upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`),
    ...lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse(),
  ].join(" ");

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((rx - padX) / (w - 2 * padX)) * Math.max(series.length - 1, 1));
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Legend color="#34d399" label="Average price" />
        {showMa && <Legend color="#f59e0b" label={`MA ${period}d`} />}
        {showChannel && <Legend color="#38bdf8" label={`Donchian ${period}d`} />}
        {showMedian && <Legend color="#a78bfa" label="Daily median" />}
        <span className="ml-auto tabular-nums text-zinc-300">
          {hover != null
            ? `${series[hover].date} · ${formatIsk(avg[hover])}` +
              (showMedian ? ` · med ${formatIsk(med[hover])}` : "") +
              (showChannel ? ` · ${formatIsk(lower[hover])}–${formatIsk(upper[hover])}` : "")
            : `${formatIsk(min)} – ${formatIsk(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {grid.map((gy, i) => (
          <line key={i} x1={padX} x2={w - padX} y1={gy} y2={gy} stroke="#27272a" strokeWidth="0.75" />
        ))}
        {showChannel && (
          <>
            <polygon points={band} fill="#38bdf8" fillOpacity="0.08" stroke="none" />
            <polyline points={line(upper)} fill="none" stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.8" />
            <polyline points={line(lower)} fill="none" stroke="#38bdf8" strokeWidth="1" strokeDasharray="3 3" strokeOpacity="0.8" />
          </>
        )}
        {showMedian && (
          <polyline points={line(med)} fill="none" stroke="#a78bfa" strokeWidth="1.5" strokeDasharray="5 4" />
        )}
        <polyline points={line(avg)} fill="none" stroke="#34d399" strokeWidth="1.5" />
        {showMa && <polyline points={line(ma)} fill="none" stroke="#f59e0b" strokeWidth="1.5" />}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padY} y2={h - padY} stroke="#52525b" strokeWidth="0.75" />
            <circle cx={x(hover)} cy={y(avg[hover])} r="3" fill="#34d399" />
          </g>
        )}
      </svg>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      <span className="text-zinc-400">{label}</span>
    </span>
  );
}

/** An inline SVG line chart with horizontal gridlines, a legend, value-axis
 *  labels and a hover readout (no chart dependency). */
function Chart({
  series,
  pick,
  label,
  color,
  fmt,
}: {
  series: HistoryPoint[];
  pick: (p: HistoryPoint) => number;
  label: string;
  color: string;
  fmt: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 960;
  const h = 200;
  const padX = 8;
  const padY = 10;
  const vals = series.map(pick);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) => padX + (i / Math.max(vals.length - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - 2 * padY);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(((rx - padX) / (w - 2 * padX)) * Math.max(vals.length - 1, 1));
    setHover(Math.max(0, Math.min(vals.length - 1, i)));
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
        <span className="text-zinc-400">{label}</span>
        <span className="ml-auto tabular-nums text-zinc-300">
          {hover != null
            ? `${series[hover].date} · ${fmt(vals[hover])}`
            : `${fmt(min)} – ${fmt(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {grid.map((gy, i) => (
          <line key={i} x1={padX} x2={w - padX} y1={gy} y2={gy} stroke="#27272a" strokeWidth="0.75" />
        ))}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padY} y2={h - padY} stroke="#52525b" strokeWidth="0.75" />
            <circle cx={x(hover)} cy={y(vals[hover])} r="3" fill={color} />
          </g>
        )}
      </svg>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`tabular-nums ${accent ?? "text-zinc-200"}`}>{value}</div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
