import { useQuery } from "@tanstack/react-query";
import { intelFwStats, type FwRow } from "../../lib/api";
import { formatInt } from "../../lib/format";

// Faction-warfare militia standings, grouped by warzone. Public data.
export function FactionWarfarePage() {
  const q = useQuery({
    queryKey: ["intel", "fw"],
    queryFn: intelFwStats,
    staleTime: 10 * 60_000,
  });

  // Group militias by warzone so the two sides sit together.
  const zones = new Map<string, FwRow[]>();
  for (const r of q.data ?? []) {
    const key = r.warzone || "Other";
    const list = zones.get(key);
    if (list) list.push(r);
    else zones.set(key, [r]);
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Faction warfare
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Militia control by warzone — systems held, active pilots and recent
            kills. Public data, no login required.
          </p>
        </div>
        <button
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {q.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div className="mt-5">
        {q.isLoading ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : q.isError ? (
          <div className="text-sm text-rose-400">{String(q.error)}</div>
        ) : q.data?.length === 0 ? (
          <div className="text-sm text-zinc-500">No faction-warfare data.</div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {[...zones.entries()].map(([zone, rows]) => (
              <div
                key={zone}
                className="overflow-hidden rounded-lg border border-zinc-800"
              >
                <div className="bg-zinc-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  {zone}
                </div>
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-zinc-900/60 text-zinc-500">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">
                        Militia
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium">
                        Systems
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium">
                        Pilots
                      </th>
                      <th className="px-3 py-1.5 text-right font-medium">
                        Kills 24h
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr
                        key={i}
                        className="border-t border-zinc-800 text-zinc-300"
                      >
                        <td className="px-3 py-1.5">{r.faction}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-100">
                          {formatInt(r.systemsControlled)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                          {formatInt(r.pilots)}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                          {formatInt(r.killsYesterday)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
