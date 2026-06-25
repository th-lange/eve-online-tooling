import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { sdeStatus, systemActivity, type SystemActivity } from "../../lib/api";
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

      <ActivityTable rows={filtered} />
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
