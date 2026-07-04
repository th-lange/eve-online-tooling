import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  intelIncursions,
  intelFwStats,
  type IncursionRow,
  type FwRow,
} from "../../lib/api";
import { formatInt } from "../../lib/format";

// Read-only "state of the cluster" panels. Both back onto public ESI, so this
// page works without logging a character in.
export function IntelPage() {
  return (
    <div className="space-y-8 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Intel</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Live public status — active incursions and faction-warfare control. No
          login required.
        </p>
      </div>
      <Incursions />
      <FactionWarfare />
    </div>
  );
}

const STATE_STYLE: Record<string, string> = {
  established: "bg-emerald-500/15 text-emerald-300",
  mobilizing: "bg-amber-500/15 text-amber-300",
  withdrawing: "bg-rose-500/15 text-rose-300",
};

function Incursions() {
  const q = useQuery({
    queryKey: ["intel", "incursions"],
    queryFn: intelIncursions,
    staleTime: 5 * 60_000,
  });
  return (
    <Panel
      title="Incursions"
      subtitle="Active Sansha incursions, most-contested first."
      loading={q.isLoading}
      error={q.isError ? String(q.error) : null}
      empty={q.data?.length === 0 ? "No active incursions right now." : null}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {q.data?.map((r, i) => (
          <IncursionCard key={i} row={r} />
        ))}
      </div>
    </Panel>
  );
}

function IncursionCard({ row }: { row: IncursionRow }) {
  const pct = Math.round(row.influence * 100);
  const stateClass = STATE_STYLE[row.state] ?? "bg-zinc-700/40 text-zinc-300";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-zinc-100">
            {row.staging}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {row.constellation} · {row.systems} systems
          </div>
        </div>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${stateClass}`}
        >
          {row.state}
        </span>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <span>Influence</span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        {/* Influence bar: high influence = far from ending. */}
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full rounded bg-indigo-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {row.hasBoss && (
        <div className="mt-3 inline-flex items-center rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fuchsia-300">
          Mothership spawned
        </div>
      )}
    </div>
  );
}

function FactionWarfare() {
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
    <Panel
      title="Faction warfare"
      subtitle="Militia control by warzone — systems held, active pilots and recent kills."
      loading={q.isLoading}
      error={q.isError ? String(q.error) : null}
      empty={q.data?.length === 0 ? "No faction-warfare data." : null}
    >
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
                  <th className="px-3 py-1.5 text-left font-medium">Militia</th>
                  <th className="px-3 py-1.5 text-right font-medium">
                    Systems
                  </th>
                  <th className="px-3 py-1.5 text-right font-medium">Pilots</th>
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
    </Panel>
  );
}

/** Section shell with a title and loading / error / empty states. */
function Panel({
  title,
  subtitle,
  loading,
  error,
  empty,
  children,
}: {
  title: string;
  subtitle: string;
  loading: boolean;
  error: string | null;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
      <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>
      <div className="mt-3">
        {loading ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="text-sm text-rose-400">{error}</div>
        ) : empty ? (
          <div className="text-sm text-zinc-500">{empty}</div>
        ) : (
          children
        )}
      </div>
    </section>
  );
}
