import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  sdeStatus,
  systemActivity,
  systemNeighbourhood,
  systemSearch,
  type NeighbourNode,
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

function Workbench() {
  const [search, setSearch] = useState("");
  const activity = useQuery({
    queryKey: ["route", "systemActivity"],
    queryFn: () => systemActivity(false),
  });

  const rows = activity.data ?? [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      `${r.name} ${r.region}`.toLowerCase().includes(q),
    );
  }, [rows, search]);

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

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          placeholder="Search system / region…"
          className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <span className="text-xs text-zinc-500">
          {formatInt(filtered.length)} active system(s) · refreshed hourly by CCP
        </span>
      </div>

      {activity.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(activity.error)}
        </div>
      )}

      <Neighbourhood />

      <h2 className="mt-6 text-sm font-semibold text-zinc-300">All active systems</h2>
      <ActivityTable rows={filtered} />
    </div>
  );
}

/** Pick a system → see its stargate neighbourhood out to N jumps, with heat.
 * The "fog-of-war" view; until the location scope (#99) lands, the centre is
 * chosen by search rather than auto-centred on your ship. */
function Neighbourhood() {
  const [query, setQuery] = useState("");
  const [depth, setDepth] = useState(2);
  const [picked, setPicked] = useState<SystemMatch | null>(null);

  const matches = useQuery({
    queryKey: ["route", "systemSearch", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2,
  });
  const hood = useMutation({
    mutationFn: (v: { id: number; depth: number }) => systemNeighbourhood(v.id, v.depth),
  });

  function pick(m: SystemMatch) {
    setPicked(m);
    setQuery(m.name);
    hood.mutate({ id: m.id, depth });
  }
  function changeDepth(d: number) {
    setDepth(d);
    if (picked) hood.mutate({ id: picked.id, depth: d });
  }

  const showResults =
    query.trim().length >= 2 && (!picked || picked.name !== query);
  const byDistance = useMemo(() => groupByDistance(hood.data?.nodes ?? []), [hood.data]);

  return (
    <div className="mt-5 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-zinc-300">Neighbourhood</span>
        <div className="relative">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setPicked(null);
            }}
            placeholder="Find a system…"
            className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {showResults && (matches.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-56 w-56 overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-lg">
              {matches.data!.map((m) => (
                <button
                  key={m.id}
                  onClick={() => pick(m)}
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
              onClick={() => changeDepth(d)}
              className={`rounded px-2 py-0.5 ${
                depth === d ? "bg-zinc-700 text-zinc-100" : "bg-zinc-800 text-zinc-400"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        {hood.isPending && <span className="text-xs text-zinc-500">Loading…</span>}
      </div>

      {hood.isError && (
        <div className="mt-2 text-sm text-rose-400">Failed: {String(hood.error)}</div>
      )}

      {hood.data && (
        <div className="mt-3 space-y-3">
          {byDistance.map(([dist, nodes]) => (
            <div key={dist}>
              <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
                {dist === 0 ? "Centre" : `${dist} jump${dist > 1 ? "s" : ""}`} · {nodes.length}
              </div>
              <div className="flex flex-wrap gap-2">
                {nodes.map((n) => (
                  <SystemChip key={n.systemId} node={n} center={dist === 0} />
                ))}
              </div>
            </div>
          ))}
          {hood.data.nodes.length <= 1 && (
            <div className="text-xs text-zinc-500">
              No stargate neighbours (wormhole systems have none).
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SystemChip({ node, center }: { node: NeighbourNode; center: boolean }) {
  const danger = node.shipKills + node.podKills;
  const border = center
    ? "border-emerald-500"
    : danger > 0
      ? "border-rose-600"
      : "border-zinc-700";
  return (
    <div
      className={`rounded border ${border} bg-zinc-900 px-2 py-1 text-xs`}
      title={`${node.region} · ${node.jumps} jumps · ${node.shipKills} ship / ${node.podKills} pod / ${node.npcKills} NPC kills (last hour)`}
    >
      <span className={secColor(node.security)}>{node.security.toFixed(1)}</span>{" "}
      <span className="text-zinc-200">{node.name || `#${node.systemId}`}</span>
      <span className="ml-2 text-zinc-500">↻{formatInt(node.jumps)}</span>
      {danger > 0 && <span className="ml-1 text-rose-400">☠{formatInt(danger)}</span>}
    </div>
  );
}

/** Group nodes into [distance, nodes] pairs, ascending by distance. */
function groupByDistance(nodes: NeighbourNode[]): [number, NeighbourNode[]][] {
  const map = new Map<number, NeighbourNode[]>();
  for (const n of nodes) {
    const arr = map.get(n.distance) ?? [];
    arr.push(n);
    map.set(n.distance, arr);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
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
