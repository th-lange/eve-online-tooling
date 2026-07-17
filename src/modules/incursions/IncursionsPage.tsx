import { useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  intelIncursions,
  type IncursionRow,
} from "../../lib/api";
import { Page, PageHeader } from "../../components/page";

const STATE_STYLE: Record<string, string> = {
  established: "bg-emerald-500/15 text-emerald-300",
  mobilizing: "bg-amber-500/15 text-amber-300",
  withdrawing: "bg-rose-500/15 text-rose-300",
};

// Active Sansha incursions — public data, no login required.
export function IncursionsPage() {
  const q = useQuery({
    queryKey: ["intel", "incursions"],
    queryFn: intelIncursions,
    staleTime: 5 * 60_000,
  });

  return (
    <Page>
      <PageHeader
        title="Incursions"
        subtitle="Active Sansha incursions, most-contested first. Public data, no login required."
        actions={
          <button
            onClick={() => q.refetch()}
            disabled={q.isFetching}
            className="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {q.isFetching ? "Loading…" : "Refresh"}
          </button>
        }
      />

      <div className="mt-5">
        {q.isLoading ? (
          <div className="text-sm text-zinc-500">Loading…</div>
        ) : q.isError ? (
          <div className="text-sm text-rose-400">{errorMessage(q.error)}</div>
        ) : q.data?.length === 0 ? (
          <div className="text-sm text-zinc-500">
            No active incursions right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {q.data?.map((r, i) => (
              <IncursionCard key={i} row={r} />
            ))}
          </div>
        )}
      </div>
    </Page>
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
