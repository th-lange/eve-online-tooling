import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  errorMessage,
  isAuthRequired,
  marketOrders,
  openMarketWindow,
  productionProfit,
  type OrderRow,
  type ProfitBreakdown,
} from "../../lib/api";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import { formatInt, formatIsk } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { DataAge } from "../../components/DataAge";
import { Page, PageHeader, PrimaryButton } from "../../components/page";

export function OrdersPage() {
  const orders = useQuery({
    queryKey: ["orders", "market"],
    queryFn: marketOrders,
  });
  const rows = useMemo(() => orders.data ?? [], [orders.data]);
  const undercut = rows.filter((r) => r.undercut).length;
  // Show the Character column only once orders span more than one character
  // (i.e. "All characters" is active); single-character views stay exactly
  // as before.
  const multiCharacter = useMemo(
    () => new Set(rows.map((r) => r.characterId)).size > 1,
    [rows],
  );
  const [checkCost, setCheckCost] = useState(false);
  // Build cost per product from the Production engine — pulled only when the
  // user asks (it computes the whole manufacturable set). Cached for the session.
  const costs = useQuery({
    queryKey: ["production", "buildCosts"],
    queryFn: async (): Promise<BuildCosts> => {
      // Price each order's build cost at *its own station* when that station has
      // a full market, else the order's region average (a Jita order → Jita, an
      // Amarr order → Amarr). Region maps are the fallback; station maps keep
      // only items the station could fully price.
      const sells = rows.filter((r) => !r.isBuy);
      const regionIds = [...new Set(sells.map((r) => r.regionId))];
      const stations = [
        ...new Map(
          sells.map((r) => [
            `${r.regionId}:${r.locationId}`,
            { regionId: r.regionId, locationId: r.locationId },
          ]),
        ).values(),
      ];
      const region = new Map<number, Map<number, number>>();
      const station = new Map<string, Map<number, number>>();
      await Promise.all([
        ...regionIds.map(async (regionId) => {
          const b = await productionProfit({ regionId });
          region.set(regionId, buildCostMap(b, false));
        }),
        ...stations.map(async ({ regionId, locationId }) => {
          const b = await productionProfit({ regionId, stationId: locationId });
          station.set(`${regionId}:${locationId}`, buildCostMap(b, true));
        }),
      ]);
      return { region, station };
    },
    enabled: checkCost,
    staleTime: Infinity,
  });
  const buildCost = costs.data;
  const belowCost = useMemo(
    () =>
      buildCost ? rows.filter((r) => isBelowBuildCost(r, buildCost)).length : 0,
    [rows, buildCost],
  );

  return (
    <Page>
      <PageHeader
        title="Market Orders"
        subtitle="Your open buy/sell orders, flagged when undercut at the order's own station's current best price."
        actions={
          <>
            <button
              onClick={() => setCheckCost(true)}
              disabled={costs.isFetching}
              title="Flag sell orders whose undercut price would fall below the item's build cost (from Production)"
              className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {costs.isFetching
                ? "Checking…"
                : buildCost
                  ? "Re-check cost"
                  : "Check build cost"}
            </button>
            <PrimaryButton
              onClick={() => orders.refetch()}
              disabled={orders.isFetching}
              pending={orders.isFetching}
              pendingLabel="Loading…"
            >
              Refresh
            </PrimaryButton>
            <DataAge
              updatedAt={orders.dataUpdatedAt}
              fetching={orders.isFetching}
            />
          </>
        }
      />

      {orders.isError &&
        (isAuthRequired(orders.error) ? (
          <div className="mt-3 text-sm text-zinc-400">
            Log in a character first to view your market orders.
          </div>
        ) : (
          <div className="mt-3 text-sm text-rose-400">
            Failed: {errorMessage(orders.error)}
            <div className="mt-1 text-xs text-zinc-500">
              Needs the <code>esi-markets.read_character_orders.v1</code> scope
              — re-login after it's enabled on the EVE app.
            </div>
          </div>
        ))}

      {rows.length > 0 && (
        <div className="mt-3 text-sm text-zinc-400">
          {formatInt(rows.length)} open order(s) ·{" "}
          <span className={undercut > 0 ? "text-rose-400" : "text-emerald-400"}>
            {formatInt(undercut)} undercut
          </span>
          {buildCost && (
            <>
              {" · "}
              <span
                className={belowCost > 0 ? "text-amber-400" : "text-zinc-500"}
              >
                {formatInt(belowCost)} below build cost
              </span>
            </>
          )}
        </div>
      )}
      {costs.isError && (
        <div className="mt-2 text-xs text-amber-500">
          Couldn't compute build costs — the Production static data may not be
          installed.
        </div>
      )}

      <OrdersTable
        rows={rows}
        showCharacter={multiCharacter}
        buildCost={buildCost}
      />
    </Page>
  );
}

type OrderSortKey =
  "name" | "price" | "bestPrice" | "volumeRemain" | "location" | "issued";

const COLUMNS: SortColumn<OrderSortKey>[] = [
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item, with buy/sell side.",
  },
  {
    key: "price",
    label: "Your price",
    numeric: true,
    description: "Your order price.",
  },
  {
    key: "bestPrice",
    label: "Best",
    numeric: true,
    description:
      "Best competing price at this order's station (sell-min / buy-max).",
  },
  {
    key: "volumeRemain",
    label: "Remain",
    numeric: true,
    description: "Units left / total on the order.",
  },
  {
    key: "location",
    label: "Location",
    numeric: false,
    description: "Where the order sits.",
  },
  {
    key: "issued",
    label: "Issued",
    numeric: false,
    description: "When the order was placed.",
  },
];
const KEYS = COLUMNS.map((c) => c.key);

function OrdersTable({
  rows,
  showCharacter,
  buildCost,
}: {
  rows: OrderRow[];
  showCharacter: boolean;
  buildCost?: BuildCosts;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<OrderSortKey>(
    "sort.orders",
    KEYS,
    "name",
    "asc",
    ["name", "location", "issued"],
  );
  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      if (sortKey === "location")
        return dir * a.location.localeCompare(b.location);
      if (sortKey === "issued") return dir * a.issued.localeCompare(b.issued);
      if (sortKey === "bestPrice")
        return dir * ((a.bestPrice ?? 0) - (b.bestPrice ?? 0));
      return dir * ((a[sortKey] as number) - (b[sortKey] as number));
    });
  }, [rows, sortKey, sortDir]);

  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            {showCharacter && (
              <th className="px-3 py-1.5 text-left font-medium">Character</th>
            )}
            {COLUMNS.map((c) => (
              <SortHeaderCell
                key={c.key}
                column={c}
                active={sortKey === c.key}
                dir={sortDir}
                onClick={toggleSort}
              />
            ))}
            <th className="px-3 py-1.5 text-right font-medium">Undercut</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.orderId}
              className={`border-t border-zinc-800 hover:bg-zinc-800/40 ${
                r.undercut ? "bg-rose-950/30" : ""
              }`}
            >
              {showCharacter && (
                <td className="px-3 py-1.5 text-zinc-400">{r.characterName}</td>
              )}
              <td className="px-3 py-1.5">
                <span className="text-zinc-200">{r.name}</span>
                <span
                  className={`ml-2 text-xs ${r.isBuy ? "text-sky-400" : "text-emerald-400"}`}
                >
                  {r.isBuy ? "buy" : "sell"}
                </span>
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatIsk(r.price)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.bestPrice == null ? "—" : formatIsk(r.bestPrice)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.volumeRemain)} / {formatInt(r.volumeTotal)}
              </td>
              <td className="px-3 py-1.5 text-zinc-400">{r.location}</td>
              <td className="px-3 py-1.5 text-xs text-zinc-500">
                {r.issued.slice(0, 10)}
              </td>
              <td className="px-3 py-1.5">
                <div className="flex items-center justify-end gap-2">
                  {(() => {
                    const cost =
                      !r.isBuy && buildCost ? costOf(r, buildCost) : undefined;
                    if (cost != null && undercutPrice(r) < cost) {
                      return (
                        <span
                          title={`Build cost ≈ ${formatIsk(cost)}/unit — undercutting sells at a loss`}
                          className="rounded border border-amber-700 px-1.5 py-0.5 text-xs text-amber-300"
                        >
                          below cost
                        </span>
                      );
                    }
                    return r.undercut && r.bestPrice != null ? (
                      <button
                        onClick={() => copyUndercut(r)}
                        title="Copy a price one tick better than the current best"
                        className="rounded border border-rose-700 px-1.5 py-0.5 text-xs text-rose-300 hover:bg-rose-900/40"
                      >
                        copy {formatIsk(undercutPrice(r))}
                      </button>
                    ) : (
                      <span className="text-xs text-emerald-500">top</span>
                    );
                  })()}
                  <button
                    onClick={() =>
                      openMarketWindow(r.typeId).catch((e) => alert(String(e)))
                    }
                    title="Open this item's market window in the EVE client"
                    aria-label={`Open ${r.name} in EVE`}
                    className="inline-flex text-zinc-600 hover:text-indigo-400"
                  >
                    <ExternalLink size={13} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={COLUMNS.length + 1 + (showCharacter ? 1 : 0)}
                className="px-3 py-6 text-center text-zinc-500"
              >
                No open orders.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** One tick better than the station's best: undercut a sell, overbid a buy. */
function undercutPrice(r: OrderRow): number {
  const best = r.bestPrice ?? r.price;
  return r.isBuy ? best + 0.01 : best - 0.01;
}

interface BuildCosts {
  /** regionId → (productTypeId → per-unit build cost); the fallback basis. */
  region: Map<number, Map<number, number>>;
  /** `${regionId}:${locationId}` → costs priced at that station (only items the
   * station has a full market for, so callers fall back to the region). */
  station: Map<string, Map<number, number>>;
}

/** Per-unit build cost of a manufacturing breakdown. */
function unitCost(b: ProfitBreakdown): number {
  return (
    (b.materialCost + b.jobFee + b.blueprintCost + b.inventionCost) /
    b.unitsProduced
  );
}

/** productTypeId → per-unit cost. With `completeOnly`, drop items that had any
 * unpriced material (a station lacking a full market) so the region fills in. */
function buildCostMap(
  breakdowns: ProfitBreakdown[],
  completeOnly: boolean,
): Map<number, number> {
  const m = new Map<number, number>();
  for (const b of breakdowns) {
    if (
      b.unitsProduced > 0 &&
      (!completeOnly || b.missingPrices.length === 0)
    ) {
      m.set(b.productTypeId, unitCost(b));
    }
  }
  return m;
}

/** An order's build cost: its own station when that station fully prices the
 * item, else the region average. `undefined` if the item isn't manufacturable. */
function costOf(r: OrderRow, bc: BuildCosts): number | undefined {
  return (
    bc.station.get(`${r.regionId}:${r.locationId}`)?.get(r.typeId) ??
    bc.region.get(r.regionId)?.get(r.typeId)
  );
}

/** A sell order whose undercut price would drop below the item's build cost —
 * chasing the market means selling at a loss, so don't adjust. */
function isBelowBuildCost(r: OrderRow, bc: BuildCosts): boolean {
  if (r.isBuy) return false;
  const cost = costOf(r, bc);
  return cost != null && undercutPrice(r) < cost;
}

function copyUndercut(r: OrderRow) {
  copyToClipboard(undercutPrice(r).toFixed(2));
}
