import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  routeBreadcrumb,
  routeClearBreadcrumb,
  routeLocation,
  sdeStatus,
  systemActivity,
  systemNeighbourhood,
  systemSearch,
  type BreadcrumbEntry,
  type SystemActivity,
  type SystemMatch,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { SortHeaderCell, type SortColumn } from "../../components/SortHeaderCell";

export function RoutePage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

type Mode = "all" | "neighbouring";

function Workbench() {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [picked, setPicked] = useState<SystemMatch | null>(null);
  const [depth, setDepth] = useState(2);

  const activity = useQuery({
    queryKey: ["route", "systemActivity"],
    queryFn: () => systemActivity(false),
  });
  const hood = useMutation({
    mutationFn: (v: { id: number; depth: number }) => systemNeighbourhood(v.id, v.depth),
  });

  function pickSystem(m: SystemMatch) {
    setPicked(m);
    setMode("neighbouring");
    hood.mutate({ id: m.id, depth });
  }
  function changeDepth(d: number) {
    setDepth(d);
    if (picked) hood.mutate({ id: picked.id, depth: d });
  }

  // The table shows either every active system or the picked neighbourhood.
  const source: SystemActivity[] =
    mode === "neighbouring" ? hood.data?.nodes ?? [] : activity.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter((r) => `${r.name} ${r.region}`.toLowerCase().includes(q));
  }, [source, search]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Route</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Per-system activity over the last hour — jumps and ship/pod/NPC
            kills. Known-space only (CCP excludes wormhole systems).
          </p>
        </div>
        <button
          onClick={() => activity.refetch()}
          disabled={activity.isFetching}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {activity.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      {activity.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(activity.error)}
        </div>
      )}

      <Breadcrumb />

      <Neighbourhood
        picked={picked}
        depth={depth}
        onPick={pickSystem}
        onDepth={changeDepth}
        loading={hood.isPending}
        error={hood.isError ? String(hood.error) : null}
      />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5 text-sm">
          <button
            onClick={() => setMode("all")}
            className={`rounded px-3 py-1 ${
              mode === "all" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            All systems
          </button>
          <button
            onClick={() => setMode("neighbouring")}
            disabled={!picked}
            title={picked ? undefined : "Pick a system in Neighbourhood first"}
            className={`rounded px-3 py-1 disabled:opacity-40 ${
              mode === "neighbouring" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Neighbouring{picked ? ` · ${picked.name}` : ""}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search system / region…"
            className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <span className="text-xs text-zinc-500">
            {formatInt(filtered.length)} system(s)
            {mode === "all" ? " · refreshed hourly by CCP" : ""}
          </span>
        </div>
      </div>

      {mode === "neighbouring" && !picked ? (
        <Centered>Pick a system in Neighbourhood above to see its neighbours.</Centered>
      ) : (
        <ActivityTable rows={filtered} />
      )}
    </div>
  );
}

/** Travel breadcrumb: poll the character's location while tracking is on and
 * render the recorded path (k-space ↔ wormhole). There's no travel-history API,
 * so the trail is built by polling /location while the view is open. */
function Breadcrumb() {
  const qc = useQueryClient();
  const [tracking, setTracking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trail = useQuery({ queryKey: ["route", "breadcrumb"], queryFn: routeBreadcrumb });

  // While tracking, poll the live location every 30s and refresh the trail.
  useEffect(() => {
    if (!tracking) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const t = await routeLocation();
        if (!cancelled) {
          setError(null);
          qc.setQueryData(["route", "breadcrumb"], t);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    };
    void poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tracking, qc]);

  const entries = trail.data ?? [];

  return (
    <div className="mt-5 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-zinc-300">Travel</span>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={tracking}
            onChange={(e) => setTracking(e.currentTarget.checked)}
          />
          Track my location {tracking ? "(polling every 30s)" : ""}
        </label>
        <button
          onClick={async () => {
            await routeClearBreadcrumb();
            qc.setQueryData(["route", "breadcrumb"], []);
          }}
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Clear
        </button>
      </div>

      {error && (
        <div className="mt-2 text-xs text-rose-400">
          {error}
          <span className="ml-1 text-zinc-500">
            (needs <code>esi-location.read_location.v1</code> — re-login if just enabled)
          </span>
        </div>
      )}

      {entries.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1">
          {entries.map((e, i) => (
            <span key={`${e.systemId}-${e.enteredAt}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-zinc-600">→</span>}
              <SystemHop entry={e} current={i === entries.length - 1} />
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-xs text-zinc-500">
          No trail yet — enable tracking and fly between systems.
        </div>
      )}
    </div>
  );
}

function SystemHop({ entry, current }: { entry: BreadcrumbEntry; current: boolean }) {
  return (
    <span
      className={`rounded border px-2 py-0.5 text-xs ${
        current ? "border-emerald-500" : "border-zinc-700"
      } ${entry.wspace ? "bg-purple-950/40" : "bg-zinc-900"}`}
      title={`${entry.region}${entry.wspace ? " · wormhole" : ""}`}
    >
      {entry.wspace ? (
        <span className="text-purple-300">{entry.name}</span>
      ) : (
        <>
          <span className={secColor(entry.security)}>{entry.security.toFixed(1)}</span>{" "}
          <span className="text-zinc-200">{entry.name}</span>
        </>
      )}
    </span>
  );
}

/** Neighbourhood selectors only: pick a centre system + jump depth. The results
 * render in the "All active systems" table when its switch is set to
 * Neighbouring. Centre is chosen by search (auto-centre on your ship is a #99
 * follow-up). */
function Neighbourhood({
  picked,
  depth,
  onPick,
  onDepth,
  loading,
  error,
}: {
  picked: SystemMatch | null;
  depth: number;
  onPick: (m: SystemMatch) => void;
  onDepth: (d: number) => void;
  loading: boolean;
  error: string | null;
}) {
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: ["route", "systemSearch", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2,
  });
  const showResults =
    query.trim().length >= 2 && (!picked || picked.name !== query.trim());

  return (
    <div className="mt-5 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-zinc-300">Neighbourhood</span>
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={picked ? picked.name : "Find a system…"}
            className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {showResults && (matches.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-56 overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-lg">
              {matches.data!.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    onPick(m);
                    setQuery("");
                  }}
                  className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-zinc-400">
          jumps:
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              onClick={() => onDepth(d)}
              className={`rounded px-2 py-0.5 ${
                depth === d ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-zinc-500">Loading…</span>}
        {picked && !loading && (
          <span className="text-xs text-zinc-500">
            Centre: <span className="text-zinc-300">{picked.name}</span> — shown in the table below.
          </span>
        )}
      </div>
      {error && <div className="mt-2 text-sm text-rose-400">Failed: {error}</div>}
    </div>
  );
}

type ActSortKey =
  | "name"
  | "region"
  | "security"
  | "jumps"
  | "shipKills"
  | "podKills"
  | "npcKills";

const COLUMNS: SortColumn<ActSortKey>[] = [
  { key: "name", label: "System", numeric: false, description: "Solar system." },
  { key: "region", label: "Region", numeric: false, description: "Region the system is in." },
  { key: "security", label: "Sec", numeric: true, description: "Security status (−1.0 … 1.0)." },
  { key: "jumps", label: "Jumps", numeric: true, description: "Ship jumps into the system in the last hour." },
  { key: "shipKills", label: "Ships", numeric: true, description: "Ship kills in the last hour." },
  { key: "podKills", label: "Pods", numeric: true, description: "Pod kills in the last hour — the PvP/gank signal." },
  { key: "npcKills", label: "NPCs", numeric: true, description: "NPC kills in the last hour — ratting/activity." },
];
const KEYS = COLUMNS.map((c) => c.key);

function ActivityTable({ rows }: { rows: SystemActivity[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<ActSortKey>(
    "sort.route.activity",
    KEYS,
    "jumps",
    "desc",
    ["name", "region"],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      if (sortKey === "region") return dir * a.region.localeCompare(b.region);
      return dir * (a[sortKey] - b[sortKey]);
    });
  }, [rows, sortKey, sortDir]);

  return (
    <div className="mt-4 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            {COLUMNS.map((c) => (
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
            <tr key={r.systemId} className="border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/40">
              <td className="px-3 py-1.5 text-zinc-200">{r.name}</td>
              <td className="px-3 py-1.5 text-zinc-400">{r.region}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${secColor(r.security)}`}>
                {r.security.toFixed(1)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{formatInt(r.jumps)}</td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${r.shipKills > 0 ? "text-rose-400" : "text-zinc-500"}`}>
                {formatInt(r.shipKills)}
              </td>
              <td className={`px-3 py-1.5 text-right tabular-nums ${r.podKills > 0 ? "text-rose-300" : "text-zinc-500"}`}>
                {formatInt(r.podKills)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{formatInt(r.npcKills)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={KEYS.length} className="px-3 py-6 text-center text-zinc-500">
                No system activity (load may be in progress).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Color the security number by band: hi-sec green, low-sec amber, null/neg red. */
function secColor(sec: number): string {
  if (sec >= 0.5) return "text-emerald-400";
  if (sec > 0.0) return "text-amber-400";
  return "text-rose-400";
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
