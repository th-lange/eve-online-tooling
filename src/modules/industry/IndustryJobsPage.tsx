import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { industryJobs, type JobRow } from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";

export function IndustryJobsPage() {
  const jobs = useQuery({ queryKey: ["industry", "jobs"], queryFn: industryJobs });
  const rows = jobs.data ?? [];
  const active = rows.filter((r) => r.status === "active" || r.status === "ready").length;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Industry Jobs</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Your running and recently-delivered industry jobs — what's cooking,
            and when it finishes.
          </p>
        </div>
        <button
          onClick={() => jobs.refetch()}
          disabled={jobs.isFetching}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {jobs.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      {jobs.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(jobs.error)}
          <div className="mt-1 text-xs text-zinc-500">
            Needs the <code>esi-industry.read_character_jobs.v1</code> scope —
            re-login after it's enabled on the EVE app.
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3 text-sm text-zinc-400">
          {formatInt(rows.length)} job(s) · {formatInt(active)} running
        </div>
      )}

      <JobsTable rows={rows} />
    </div>
  );
}

function JobsTable({ rows }: { rows: JobRow[] }) {
  const now = useMemo(() => Date.now(), [rows]);
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Product</th>
            <th className="px-3 py-1.5 text-left font-medium">Activity</th>
            <th className="px-3 py-1.5 text-right font-medium">Runs</th>
            <th className="px-3 py-1.5 text-left font-medium">Status</th>
            <th className="px-3 py-1.5 text-left font-medium">Finishes</th>
            <th className="px-3 py-1.5 text-right font-medium">Fee</th>
            <th className="px-3 py-1.5 text-left font-medium">Facility</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.jobId} className="border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/40">
              <td className="px-3 py-1.5 text-zinc-200">{r.product}</td>
              <td className="px-3 py-1.5 text-zinc-400">{r.activity}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{formatInt(r.runs)}</td>
              <td className="px-3 py-1.5">
                <span className={statusColor(r.status)}>{r.status || "—"}</span>
              </td>
              <td className="px-3 py-1.5 text-zinc-400">{finishLabel(r, now)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.cost == null ? "—" : formatIsk(r.cost)}
              </td>
              <td className="px-3 py-1.5 text-zinc-500">{r.facility || "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-zinc-500">
                No industry jobs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function statusColor(status: string): string {
  if (status === "active") return "text-emerald-400";
  if (status === "ready") return "text-amber-400";
  if (status === "delivered") return "text-zinc-400";
  return "text-zinc-500";
}

/** "in 3h 20m" for running jobs, else the end date. */
function finishLabel(r: JobRow, now: number): string {
  if (r.status !== "active" || !r.endDate) return r.endDate?.slice(0, 16).replace("T", " ") || "—";
  const end = Date.parse(r.endDate);
  if (Number.isNaN(end)) return r.endDate;
  const ms = end - now;
  if (ms <= 0) return "ready";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}
