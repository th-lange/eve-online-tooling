import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import {
  marketCurrentLocation,
  systemSearch,
  pochvenRoutes,
  pochvenSearch,
  type PochvenStat,
  type EntrySearch as EntrySearchResult,
} from "../../lib/api";
import {
  C729,
  POCHVEN_SYSTEMS,
  POCHVEN_META,
  FILAMENTS,
  systemsByRole,
  systemsByClade,
  INTERNAL,
} from "./data";

// Pochven "get me in" tools + reference (epic #417).
export function PochvenPage() {
  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-semibold text-zinc-100">Pochven entry</h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-400">
        Pochven has no gates to k-space — you get in via a <strong>C729</strong>{" "}
        wormhole or a filament. Enter your current system and it'll route you to
        the nearest C729 spawn candidate and list the systems to jump &amp;
        scan.
      </p>

      <EntryFinder />

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
      <FilamentGuide />

      <p className="mt-4 text-[11px] text-zinc-600">
        Entry data: Electus Matari Pochven entry manual. Hub distances computed
        live over the stargate graph.
      </p>
    </div>
  );
}

// Active entry search: from your current system, route to the nearest C729
// candidate and list the systems to jump & scan.
function EntryFinder() {
  const [systemId, setSystemId] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");

  const search = useQuery({
    queryKey: ["system", "search", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2,
    staleTime: 60_000,
  });
  const location = useQuery({
    queryKey: ["market", "currentLocation"],
    queryFn: marketCurrentLocation,
    staleTime: 60_000,
    enabled: false,
  });
  const result = useQuery({
    queryKey: ["pochven", "search", systemId],
    queryFn: () => pochvenSearch(systemId!),
    enabled: systemId != null,
    staleTime: 5 * 60_000,
  });

  const pick = (id: number, name: string) => {
    setSystemId(id);
    setLabel(name);
    setQuery("");
  };

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative flex flex-col gap-1 text-xs text-zinc-400">
          Your current system
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={label || "Search a system…"}
            className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
          {query.trim().length >= 2 && (search.data?.length ?? 0) > 0 && (
            <div className="absolute top-full z-20 mt-1 max-h-56 w-64 overflow-auto rounded border border-zinc-700 bg-zinc-800 shadow-lg">
              {search.data!.slice(0, 25).map((m) => (
                <button
                  key={m.id}
                  onClick={() => pick(m.id, m.name)}
                  className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </label>
        <button
          onClick={async () => {
            const loc = await location.refetch();
            if (loc.data) pick(loc.data.systemId, loc.data.systemName);
          }}
          disabled={location.isFetching}
          title="Use your logged-in character's current system"
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          <MapPin size={13} /> Detect
        </button>
        {label && (
          <span className="pb-1 text-xs text-zinc-500">
            from <span className="text-zinc-300">{label}</span>
          </span>
        )}
      </div>

      {systemId != null &&
        (result.isLoading ? (
          <div className="mt-4 text-sm text-zinc-500">Finding entries…</div>
        ) : result.isError ? (
          <div className="mt-4 text-sm text-rose-400">
            {String(result.error)}
          </div>
        ) : result.data ? (
          <EntryResults data={result.data} />
        ) : null)}
    </div>
  );
}

function EntryResults({ data }: { data: EntrySearchResult }) {
  if (data.candidates.length === 0)
    return (
      <div className="mt-4 text-sm text-zinc-400">
        No C729 candidates reachable by gate from here — try a filament.
      </div>
    );
  return (
    <div className="mt-4 space-y-4">
      {data.route.length > 1 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">
            Route to the nearest candidate ({data.route.length - 1} jumps)
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-sm">
            {data.route.map((s, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-zinc-600">→</span>}
                <span
                  className={
                    i === data.route.length - 1
                      ? "font-medium text-sky-300"
                      : "text-zinc-300"
                  }
                >
                  {s}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-sm text-zinc-300">
          Systems to jump &amp; scan (nearest first)
        </div>
        <div className="overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">System</th>
                <th className="px-3 py-1.5 text-left font-medium">Region</th>
                <th className="px-3 py-1.5 text-right font-medium">Jumps</th>
                <th className="px-3 py-1.5 text-left font-medium">
                  C729 leads to
                </th>
              </tr>
            </thead>
            <tbody>
              {data.candidates.map((c) => (
                <tr
                  key={c.system}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1.5 font-medium text-zinc-200">
                    {c.system}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-500">{c.region}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {c.jumps}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">
                    {c.leadsTo.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Filament entry guide (#416): how filaments drop you into Pochven by role /
// clade, with fleet caps and requirements. Data-driven from the clade/role map.
function FilamentGuide() {
  const byRole = useMemo(() => systemsByRole(), []);
  const byClade = useMemo(() => systemsByClade(), []);

  return (
    <section className="mt-8">
      <h2 className="text-lg font-semibold text-zinc-100">Filaments</h2>
      <p className="mt-1 max-w-3xl text-sm text-zinc-400">
        Filaments jump a small fleet straight into Pochven — capped at{" "}
        <strong>1 / 5 / 15</strong> sub-caps (the number in the filament name).{" "}
        {FILAMENTS.note}
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* By role — System-type filaments. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-sm font-medium text-zinc-200">
            System-type filaments
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Drop into a random system of that role (any clade).
          </p>
          <div className="mt-3 space-y-2">
            {(["Home", "Border", "Internal"] as const).map((role) => (
              <div key={role} className="text-sm">
                <span className="inline-block w-20 font-medium text-zinc-300">
                  {role}
                </span>
                <span className="text-zinc-500">{byRole[role].join(", ")}</span>
              </div>
            ))}
          </div>
        </div>

        {/* By clade — Cladistic filaments. */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-sm font-medium text-zinc-200">
            Cladistic filaments
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            Drop into a random system of that clade.
          </p>
          <div className="mt-3 space-y-2">
            {(["Perun", "Svarog", "Veles"] as const).map((clade) => (
              <div key={clade} className="text-sm">
                <span className="inline-block w-20 font-medium text-zinc-300">
                  {clade}
                </span>
                <span className="text-zinc-500">
                  {byClade[clade].join(", ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-400">
        <span className="font-semibold uppercase tracking-wide text-zinc-500">
          To activate a filament
        </span>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {FILAMENTS.requirements.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    </section>
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
                <th className="px-3 py-1.5 text-left font-medium">Clade</th>
                <th className="px-3 py-1.5 text-left font-medium">Role</th>
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
                  <td className="px-3 py-1.5 text-zinc-400">
                    {POCHVEN_META[r.system]?.clade ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">
                    {POCHVEN_META[r.system]?.role ?? "—"}
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
