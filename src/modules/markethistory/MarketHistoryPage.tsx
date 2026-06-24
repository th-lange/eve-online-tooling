import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  marketHistory,
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

  const series = useMemo(() => (history.data ?? []).slice(-days), [history.data, days]);

  return (
    <div className="p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Market history</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Daily price &amp; volume trend for an item in a region.
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

      <div className="mt-4">
        {!picked ? (
          <Centered>Search for an item to see its history.</Centered>
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
      <Spark series={series} pick={(p) => p.average} label="Average price" color="#34d399" />
      <div className="h-2" />
      <Spark series={series} pick={(p) => p.volume} label="Daily volume" color="#60a5fa" />
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

/** A minimal inline SVG sparkline (no chart dependency). */
function Spark({
  series,
  pick,
  label,
  color,
}: {
  series: HistoryPoint[];
  pick: (p: HistoryPoint) => number;
  label: string;
  color: string;
}) {
  const w = 720;
  const h = 64;
  const vals = series.map(pick);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals
    .map((v, i) => {
      const x = (i / Math.max(vals.length - 1, 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 text-xs text-zinc-500">{label}</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="tabular-nums text-zinc-200">{value}</div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
