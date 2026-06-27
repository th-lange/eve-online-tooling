import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  marketHistory,
  marketPrice,
  marketRegions,
  openMarketWindow,
  sdeSearch,
  sdeStatus,
  type HistoryPoint,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt, formatIsk } from "../../lib/format";

const FORGE = 10000002;

export function MarketHistoryPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(null);
  const [regionId, setRegionId] = useState(FORGE);
  const [days, setDays] = useState(90);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => sdeSearch(query),
    enabled: query.trim().length >= 2 && !picked,
  });
  const history = useQuery({
    queryKey: ["history", regionId, picked?.id],
    queryFn: () => marketHistory(regionId, picked!.id),
    enabled: picked != null,
  });
  // Current order-book prices for the picked item in the region.
  const price = useQuery({
    queryKey: ["price", regionId, picked?.id],
    queryFn: () => marketPrice(regionId, picked!.id),
    enabled: picked != null,
  });

  const series = useMemo(() => (history.data ?? []).slice(-days), [history.data, days]);

  return (
    <div className="p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Market</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Current prices plus the daily price &amp; volume trend for an item in a region.
        </p>
      </div>

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
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Region
          <select
            value={regionId}
            onChange={(e) => setRegionId(Number(e.currentTarget.value))}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {regions.data?.map((r) => (
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
      </div>

      {/* Current region prices */}
      {picked && price.data && (
        <div className="mt-4 flex flex-wrap gap-6 text-sm">
          <Stat label="Sell (min)" value={formatIsk(price.data.sellMin)} accent="text-rose-300" />
          <Stat label="Buy (max)" value={formatIsk(price.data.buyMax)} accent="text-emerald-300" />
          <Stat
            label="Spread"
            value={spread(price.data.sellMin, price.data.buyMax)}
          />
          <Stat label="Daily volume" value={formatInt(price.data.dailyVolume)} />
        </div>
      )}

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its prices and history.</Centered>
        ) : history.isLoading ? (
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

function spread(sell?: number | null, buy?: number | null): string {
  if (sell == null || buy == null || sell <= 0) return "—";
  return `${(((sell - buy) / sell) * 100).toFixed(1)}%`;
}

function HistoryView({ series }: { series: HistoryPoint[] }) {
  const last = series[series.length - 1];
  const avgVol = Math.round(series.reduce((s, p) => s + p.volume, 0) / series.length);
  return (
    <div>
      <div className="mb-3 flex gap-6 text-sm">
        <Stat label="Latest avg" value={formatIsk(last.average)} />
        <Stat label="Latest volume" value={formatInt(last.volume)} />
        <Stat label="Avg volume/day" value={formatInt(avgVol)} />
      </div>
      <Chart
        series={series}
        pick={(p) => p.average}
        label="Average price"
        color="#34d399"
        fmt={formatIsk}
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
  const w = 720;
  const h = 150;
  const padX = 8;
  const padY = 10;
  const vals = series.map(pick);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) =>
    padX + (i / Math.max(vals.length - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - 2 * padY);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  // Four evenly-spaced horizontal gridlines across the value range.
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(
      ((rx - padX) / (w - 2 * padX)) * Math.max(vals.length - 1, 1),
    );
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
          <line
            key={i}
            x1={padX}
            x2={w - padX}
            y1={gy}
            y2={gy}
            stroke="#27272a"
            strokeWidth="0.75"
          />
        ))}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
        {hover != null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padY}
              y2={h - padY}
              stroke="#52525b"
              strokeWidth="0.75"
            />
            <circle cx={x(hover)} cy={y(vals[hover])} r="3" fill={color} />
          </g>
        )}
      </svg>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
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
