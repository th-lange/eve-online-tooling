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
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [depth, setDepth] = useState(2);
  // Neighbourhood centre: a typed system, or the live "my location".
  const [centre, setCentre] = useState<SystemMatch | null>(null);
  const [fromMe, setFromMe] = useState(false);
  const [auto, setAuto] = useState(false);
  const [query, setQuery] = useState("");
  const [locError, setLocError] = useState<string | null>(null);

  const activity = useQuery({
    queryKey: ["route", "systemActivity"],
    queryFn: () => systemActivity(false),
  });
  const trail = useQuery({ queryKey: ["route", "breadcrumb"], queryFn: routeBreadcrumb });
  const matches = useQuery({
    queryKey: ["route", "systemSearch", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2,
  });
  const hood = useMutation({
    mutationFn: (v: { id: number; depth: number }) => systemNeighbourhood(v.id, v.depth),
  });

  // Focus the neighbourhood on a typed system.
  function focusSystem(m: SystemMatch) {
    setFromMe(false);
    setCentre(m);
    setMode("neighbouring");
    setQuery("");
    hood.mutate({ id: m.id, depth });
  }
  // Focus on the live current location (also records the travel breadcrumb).
  async function focusMyLocation(d = depth) {
    try {
      const t = await routeLocation();
      setLocError(null);
      qc.setQueryData(["route", "breadcrumb"], t);
      const last = t[t.length - 1];
      if (last) {
        setFromMe(true);
        setCentre({ id: last.systemId, name: last.name });
        setMode("neighbouring");
        hood.mutate({ id: last.systemId, depth: d });
      }
    } catch (e) {
      setLocError(String(e));
    }
  }
  function changeDepth(d: number) {
    setDepth(d);
    if (fromMe) void focusMyLocation(d);
    else if (centre) hood.mutate({ id: centre.id, depth: d });
  }
  // Manual refresh: re-pull activity + re-centre (live location if "from me").
  function update() {
    void activity.refetch();
    if (fromMe) void focusMyLocation();
    else if (centre) hood.mutate({ id: centre.id, depth });
  }

  // Auto-update every 30s while enabled (re-centres a live "my location" focus).
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      void activity.refetch();
      if (fromMe) void focusMyLocation();
      else if (centre) hood.mutate({ id: centre.id, depth });
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, fromMe, centre, depth]);

  const source: SystemActivity[] =
    mode === "neighbouring" ? hood.data?.nodes ?? [] : activity.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return source;
    return source.filter((r) => `${r.name} ${r.region}`.toLowerCase().includes(q));
  }, [source, search]);

  const showResults = query.trim().length >= 2 && (matches.data?.length ?? 0) > 0;
  const entries = trail.data ?? [];

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
        <div className="mt-3 text-sm text-rose-400">Failed: {String(activity.error)}</div>
      )}

      {/* Merged focus: type a system OR use your live location; depth + update. */}
      <div className="mt-5 rounded border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-zinc-300">Focus</span>
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={centre && !fromMe ? centre.name : "Find a system…"}
              className="w-52 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            {showResults && (
              <div className="absolute z-10 mt-1 max-h-56 w-52 overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-lg">
                {matches.data!.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => focusSystem(m)}
                    className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => void focusMyLocation()}
            className={`rounded border px-2 py-1 text-xs ${
              fromMe ? "border-emerald-600 text-emerald-300" : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
            }`}
            title="Centre on your current system (records the travel trail)"
          >
            📍 My location
          </button>
          <div className="flex items-center gap-1 text-xs text-zinc-400">
            jumps:
            {[1, 2, 3, 4, 5].map((d) => (
              <button
                key={d}
                onClick={() => changeDepth(d)}
                className={`rounded px-2 py-0.5 ${
                  depth === d ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <button
            onClick={update}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Update
          </button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
            Auto 30s
          </label>
          {centre && (
            <span className="text-xs text-zinc-500">
              Centre: <span className="text-zinc-300">{centre.name}</span>
              {fromMe ? " (you)" : ""} · {hood.isPending ? "loading…" : "shown below"}
            </span>
          )}
          {entries.length > 0 && (
            <button
              onClick={async () => {
                await routeClearBreadcrumb();
                qc.setQueryData(["route", "breadcrumb"], []);
              }}
              className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Clear trail
            </button>
          )}
        </div>

        {(locError || hood.isError) && (
          <div className="mt-2 text-xs text-rose-400">
            {locError ?? String(hood.error)}
            {locError && (
              <span className="ml-1 text-zinc-500">
                (needs <code>esi-location.read_location.v1</code> — re-login if just enabled)
              </span>
            )}
          </div>
        )}

        {entries.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Travel trail</div>
            <div className="flex flex-wrap items-center gap-1">
              {entries.map((e, i) => (
                <span key={`${e.systemId}-${e.enteredAt}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-zinc-600">→</span>}
                  <SystemHop entry={e} current={i === entries.length - 1} />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

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
            disabled={!centre}
            title={centre ? undefined : "Set a Focus above first"}
            className={`rounded px-3 py-1 disabled:opacity-40 ${
              mode === "neighbouring" ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            Around{centre ? ` · ${centre.name}` : ""}
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

      {mode === "neighbouring" && !centre ? (
        <Centered>Set a Focus above (type a system or “My location”).</Centered>
      ) : (
        <ActivityTable rows={filtered} />
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
