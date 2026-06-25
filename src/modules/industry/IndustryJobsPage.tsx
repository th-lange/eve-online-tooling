import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { industryJobs, type JobRow, type Slot } from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";

type StatusFilter = "active" | "delivered" | "all";

/** "active" = running + ready-to-deliver. */
function matchesStatus(status: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "active" || status === "ready";
  return status === filter; // "delivered"
}

export function IndustryJobsPage() {
  const jobs = useQuery({ queryKey: ["industry", "jobs"], queryFn: industryJobs });
  const allRows = jobs.data?.jobs ?? [];
  const slots = jobs.data?.slots;
  const [status, setStatus] = useState<StatusFilter>("active");
  const [facility, setFacility] = useState("all");

  // Facilities present in the data, for the location selector.
  const facilities = useMemo(
    () => [...new Set(allRows.map((r) => r.facility).filter(Boolean))].sort(),
    [allRows],
  );
  const rows = useMemo(
    () =>
      allRows.filter(
        (r) => matchesStatus(r.status, status) && (facility === "all" || r.facility === facility),
      ),
    [allRows, status, facility],
  );
  const active = allRows.filter((r) => r.status === "active" || r.status === "ready").length;

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

      {slots && (
        <div className="mt-4 flex flex-wrap gap-3">
          <SlotPill label="Manufacturing" slot={slots.manufacturing} />
          <SlotPill label="Science" slot={slots.science} />
          <SlotPill label="Reactions" slot={slots.reactions} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value as StatusFilter)}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="active">Active (running + to deliver)</option>
            <option value="delivered">Delivered</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Location
          <select
            value={facility}
            onChange={(e) => setFacility(e.currentTarget.value)}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="all">All locations</option>
            {facilities.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        {allRows.length > 0 && (
          <span className="pb-1 text-xs text-zinc-500">
            {formatInt(rows.length)} shown · {formatInt(active)} running total
          </span>
        )}
      </div>

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
            <th className="px-3 py-1.5 text-left font-medium">Owner</th>
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
              <td className="px-3 py-1.5">
                <span className={r.owner === "Corp" ? "text-sky-400" : "text-zinc-500"}>
                  {r.owner}
                </span>
              </td>
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
              <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                No industry jobs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** A used/total slot pill, amber when full. */
function SlotPill({ label, slot }: { label: string; slot: Slot }) {
  const full = slot.used >= slot.total;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm">
      <span className="text-zinc-400">{label}</span>{" "}
      <span className={`tabular-nums font-medium ${full ? "text-amber-400" : "text-zinc-100"}`}>
        {slot.used}/{slot.total}
      </span>
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
