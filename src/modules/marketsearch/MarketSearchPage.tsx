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
  type PriceModel,
  type SellOrder,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import {
  subscribeMarketSearchItem,
  takePendingMarketSearchItem,
} from "../../lib/deepLink";
import { AddToListButton } from "../../components/AddToListButton";
import { PriceHistoryView, Stat } from "../../components/PriceHistory";
import { formatInt, formatIsk, formatPercent } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { Page, PageHeader, Centered } from "../../components/page";
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

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

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
          price={price.data}
          history={history.data ?? []}
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
          <Centered>Couldn't load orders: {String(error)}</Centered>
        ) : orders.length === 0 ? (
          <Centered>
            No sell orders for this item in the selected area.
          </Centered>
        ) : (
          <OrderTable orders={orders} hasOrigin={origin != null} />
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
  price,
  history,
  loading,
}: {
  picked: Picked;
  regions: IdName[];
  regionId: number;
  setRegionId: (id: number | null) => void;
  price: PriceModel | undefined;
  history: HistoryPoint[];
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
          <PriceHistoryView history={history} />
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
  return formatPercent((sell - buy) / sell);
}
