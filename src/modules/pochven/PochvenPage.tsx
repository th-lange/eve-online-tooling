import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import {
  marketAllRegions,
  marketCurrentLocation,
  pochvenRoutes,
  type PochvenStat,
} from "../../lib/api";
import {
  C729,
  POCHVEN_SYSTEMS,
  entriesInRegion,
  pochvenRegions,
  INTERNAL,
} from "./data";

// Pochven entry finder (#415): given your region, which Pochven systems' C729
// wormholes can spawn near you. C729 spawn zones are fixed per system (Electus
// Matari data); the exact hole is still scanned in-game within that zone.
export function PochvenPage() {
  const [region, setRegion] = useState<string | null>(null);

  const regions = useQuery({
    queryKey: ["market", "allRegions"],
    queryFn: marketAllRegions,
    staleTime: Infinity,
  });
  const location = useQuery({
    queryKey: ["market", "currentLocation"],
    queryFn: marketCurrentLocation,
    staleTime: 60_000,
  });

  const matches = useMemo(
    () => (region ? entriesInRegion(region) : []),
    [region],
  );
  const hasEntries = useMemo(() => new Set(pochvenRegions()), []);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold text-zinc-100">Pochven entry</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-400">
        Each Pochven system has one <strong>C729</strong> wormhole whose k-space
        side spawns in a fixed set of regions. Pick your region (or detect it)
        to see which Pochven systems you could reach — the exact hole is still
        scanned in-game within that zone.
      </p>

      {/* Region picker + detect. */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Your region
          <select
            value={region ?? ""}
            onChange={(e) => setRegion(e.currentTarget.value || null)}
            className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="">Select a region…</option>
            {(regions.data ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name}
                  {hasEntries.has(r.name) ? " ★" : ""}
                </option>
              ))}
          </select>
        </label>
        <button
          onClick={() => {
            const loc = location.data;
            if (loc) setRegion(loc.regionName);
            else location.refetch();
          }}
          disabled={location.isFetching}
          title="Use your logged-in character's current region"
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          <MapPin size={13} /> Detect my location
        </button>
        {location.data && (
          <span className="pb-1 text-xs text-zinc-500">
            You're in{" "}
            <span className="text-zinc-300">{location.data.systemName}</span> ·{" "}
            {location.data.regionName}
          </span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-zinc-600">
        ★ = region has at least one Pochven entry.
      </div>

      {/* Results. */}
      {region && (
        <div className="mt-5">
          {matches.length === 0 ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
              No Pochven C729 entries spawn in <strong>{region}</strong>. Head
              to a neighbouring region with a ★, or use a filament.
            </div>
          ) : (
            <>
              <div className="mb-2 text-sm text-zinc-300">
                {matches.length} Pochven system
                {matches.length === 1 ? "" : "s"} reachable from{" "}
                <span className="font-medium text-zinc-100">{region}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {matches
                  .slice()
                  .sort((a, b) => b.count - a.count)
                  .map((m) => (
                    <div
                      key={m.name}
                      className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="font-medium text-zinc-100">
                          {m.name}
                        </span>
                        <span className="text-xs text-zinc-400">
                          {m.count} candidate{m.count === 1 ? "" : "s"} in{" "}
                          {region}
                        </span>
                      </div>
                      {m.others.length > 0 && (
                        <div className="mt-1 text-[11px] text-zinc-500">
                          also spawns in{" "}
                          {m.others
                            .map((z) => `${z.region} (${z.count})`)
                            .join(", ")}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* C729 specs. */}
      <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-semibold uppercase tracking-wide text-zinc-500">
          C729
        </span>
        <span>Spawn: {C729.spawnDistance}</span>
        <span>Max jump mass: {C729.maxJumpMass}</span>
        <span>Lifetime: {C729.lifetime}</span>
      </div>

      {/* Full reference. */}
      <details className="mt-6">
        <summary className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
          All 27 Pochven systems → C729 spawn regions
        </summary>
        <div className="mt-2 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">System</th>
                <th className="px-3 py-1.5 text-left font-medium">
                  C729 spawn regions (candidate count)
                </th>
              </tr>
            </thead>
            <tbody>
              {POCHVEN_SYSTEMS.map((s) => (
                <tr key={s.name} className="border-t border-zinc-800">
                  <td className="px-3 py-1.5 font-medium text-zinc-200">
                    {s.name}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">
                    {s.c729
                      .map((z) =>
                        z.region === INTERNAL
                          ? `internal (${z.count})`
                          : `${z.region} (${z.count})`,
                      )
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <Logistics />

      <p className="mt-4 text-[11px] text-zinc-600">
        Entry data: Electus Matari Pochven entry manual. Hub distances computed
        live over the stargate graph.
      </p>
    </div>
  );
}

type Pref = "shortest" | "secure" | "insecure";

// Per-system jump distances from Pochven to the trade hubs, computed live
// (#414). Pick a route preference; sort by any hub's average.
function Logistics() {
  const q = useQuery({
    queryKey: ["pochven", "routes"],
    queryFn: pochvenRoutes,
    staleTime: 60 * 60_000,
  });
  const [pref, setPref] = useState<Pref>("shortest");
  const [sortHub, setSortHub] = useState<string | null>(null);

  const hubs = q.data?.hubs ?? [];
  const rows = useMemo(() => {
    const list = (q.data?.systems ?? []).map((s) => ({
      system: s.system,
      cells: Object.fromEntries(s.hubs.map((h) => [h.hub, h[pref]])) as Record<
        string,
        PochvenStat
      >,
    }));
    if (sortHub) {
      list.sort(
        (a, b) => (a.cells[sortHub]?.avg ?? 0) - (b.cells[sortHub]?.avg ?? 0),
      );
    } else {
      list.sort((a, b) => a.system.localeCompare(b.system));
    }
    return list;
  }, [q.data, pref, sortHub]);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">
          Logistics — jumps to trade hubs
        </h2>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
          {(["shortest", "secure", "insecure"] as Pref[]).map((p) => (
            <button
              key={p}
              onClick={() => setPref(p)}
              className={`px-3 py-1 capitalize ${
                pref === p
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Average jumps from each Pochven system's C729 exit candidates to the hub
        (min–max in parentheses). Click a hub to sort.
      </p>

      {q.isLoading ? (
        <div className="mt-3 text-sm text-zinc-500">Computing routes…</div>
      ) : q.isError ? (
        <div className="mt-3 text-sm text-rose-400">{String(q.error)}</div>
      ) : (
        <div className="mt-3 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">System</th>
                {hubs.map((h) => (
                  <th
                    key={h}
                    onClick={() => setSortHub((cur) => (cur === h ? null : h))}
                    className={`cursor-pointer px-3 py-1.5 text-right font-medium hover:text-zinc-200 ${
                      sortHub === h ? "text-sky-300" : ""
                    }`}
                    title={`Sort by jumps to ${h}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.system}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1.5 font-medium text-zinc-200">
                    {r.system}
                  </td>
                  {hubs.map((h) => {
                    const s = r.cells[h];
                    return (
                      <td
                        key={h}
                        className="px-3 py-1.5 text-right tabular-nums"
                      >
                        {s ? (
                          <>
                            <span className="text-zinc-200">
                              {s.avg.toFixed(1)}
                            </span>
                            <span className="ml-1 text-[10px] text-zinc-500">
                              ({s.min}–{s.max})
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
