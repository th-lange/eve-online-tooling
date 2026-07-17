import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ALL_CHARACTERS,
  activeCharacter,
  authCharacters,
  errorMessage,
  industryJobs,
  isAuthRequired,
  type JobRow,
  type Slot,
} from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";
import { DataAge } from "../../components/DataAge";
import { Page, PageHeader, PrimaryButton } from "../../components/page";

const TITLE = "Industry Jobs";
const SUBTITLE =
  "Your running and recently-delivered industry jobs — what's cooking, and when it finishes.";

type StatusFilter = "active" | "delivered" | "all";
type Period = "1w" | "1m" | "3m" | "all";
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = {
  "1w": 7,
  "1m": 30,
  "3m": 90,
};
const PERIOD_LABEL: Record<Period, string> = {
  "1w": "1 week",
  "1m": "1 month",
  "3m": "3 months",
  all: "All time",
};

/** "active" = running + ready-to-deliver. */
function matchesStatus(status: string, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "active" || status === "ready";
  return status === filter; // "delivered"
}

/** Keep a job if it's still running (future end) or finished within the period. */
function withinPeriod(endDate: string, period: Period, now: number): boolean {
  if (period === "all") return true;
  const end = Date.parse(endDate);
  if (Number.isNaN(end)) return true;
  if (end >= now) return true; // active/future jobs always show
  return end >= now - PERIOD_DAYS[period] * 86_400_000;
}

export function IndustryJobsPage() {
  const [characterId, setCharacterId] = useState<number | undefined>(undefined);
  const characters = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const activeChar = useQuery({
    queryKey: ["auth", "active"],
    queryFn: activeCharacter,
  });
  const jobs = useQuery({
    queryKey: ["industry", "jobs", characterId ?? "first"],
    queryFn: () => industryJobs(characterId),
  });
  // Memoised so downstream useMemo deps stay referentially stable while loading.
  const allRows = useMemo(() => jobs.data?.jobs ?? [], [jobs.data]);
  const slots = jobs.data?.slots;
  const [status, setStatus] = useState<StatusFilter>("active");
  const [facility, setFacility] = useState("all");
  const [period, setPeriod] = useState<Period>("1w");
  const roster = characters.data ?? [];

  // Facilities present in the data, for the location selector.
  const facilities = useMemo(
    () => [...new Set(allRows.map((r) => r.facility).filter(Boolean))].sort(),
    [allRows],
  );
  const rows = useMemo(() => {
    const now = Date.now();
    return allRows.filter(
      (r) =>
        matchesStatus(r.status, status) &&
        (facility === "all" || r.facility === facility) &&
        withinPeriod(r.endDate, period, now),
    );
  }, [allRows, status, facility, period]);
  const active = allRows.filter(
    (r) => r.status === "active" || r.status === "ready",
  ).length;

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
            <PrimaryButton
              onClick={() => jobs.refetch()}
              disabled={jobs.isFetching}
              pending={jobs.isFetching}
              pendingLabel="Loading…"
            >
              Refresh
            </PrimaryButton>
            <DataAge
              updatedAt={jobs.dataUpdatedAt}
              fetching={jobs.isFetching}
            />
          </>
        }
      />

      {jobs.isError &&
        (isAuthRequired(jobs.error) ? (
          <div className="mt-3 text-sm text-zinc-400">
            Log in a character first to view industry jobs.
          </div>
        ) : (
          <div className="mt-3 text-sm text-rose-400">
            Failed: {errorMessage(jobs.error)}
            <div className="mt-1 text-xs text-zinc-500">
              {errorHint(errorMessage(jobs.error))}
            </div>
          </div>
        ))}

      {slots && (
        <div className="mt-4 flex flex-wrap gap-3">
          <SlotPill label="Manufacturing" slot={slots.manufacturing} />
          <SlotPill label="Science" slot={slots.science} />
          <SlotPill label="Reactions" slot={slots.reactions} />
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        {roster.length > 1 && (
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Character
            <select
              value={
                characterId ?? activeChar.data ?? roster[0]?.characterId ?? ""
              }
              onChange={(e) => {
                const value = Number(e.currentTarget.value);
                setCharacterId(value === ALL_CHARACTERS ? undefined : value);
              }}
              className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              <option value={ALL_CHARACTERS}>All characters</option>
              {roster.map((c) => (
                <option key={c.characterId} value={c.characterId}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
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
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Period
          <select
            value={period}
            onChange={(e) => setPeriod(e.currentTarget.value as Period)}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {(["1w", "1m", "3m", "all"] as Period[]).map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
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
    </Page>
  );
}

function JobsTable({ rows }: { rows: JobRow[] }) {
  // Plain read: cheap, and each render shows current countdowns.
  const now = Date.now();
  const showCharacter = new Set(rows.map((r) => r.characterId)).size > 1;
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Product</th>
            {showCharacter && (
              <th className="px-3 py-1.5 text-left font-medium">Character</th>
            )}
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
            <tr
              key={r.jobId}
              className="border-t border-zinc-800 text-zinc-300 hover:bg-zinc-800/40"
            >
              <td className="px-3 py-1.5 text-zinc-200">{r.product}</td>
              {showCharacter && (
                <td className="px-3 py-1.5 text-zinc-400">{r.characterName}</td>
              )}
              <td className="px-3 py-1.5">
                <span
                  className={
                    r.owner === "Corp" ? "text-sky-400" : "text-zinc-500"
                  }
                >
                  {r.owner}
                </span>
              </td>
              <td className="px-3 py-1.5 text-zinc-400">{r.activity}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.runs)}
              </td>
              <td className="px-3 py-1.5">
                <span className={statusColor(r.status)}>{r.status || "—"}</span>
              </td>
              <td className="px-3 py-1.5 text-zinc-400">
                {finishLabel(r, now)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {r.cost == null ? "—" : formatIsk(r.cost)}
              </td>
              <td className="px-3 py-1.5 text-zinc-500">{r.facility || "—"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={showCharacter ? 9 : 8}
                className="px-3 py-6 text-center text-zinc-500"
              >
                No industry jobs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/** Tailor the hint to the failure: scope/auth vs a transient ESI timeout. */
function errorHint(error: string): string {
  if (/403|forbidden/i.test(error)) {
    return "Looks like a permissions issue — enable esi-industry.read_character_jobs.v1 on the EVE app and re-login.";
  }
  if (/50\d|timeout|gateway/i.test(error)) {
    return "ESI is busy/timed out (the completed-jobs list is heavy) — it retries automatically; hit Refresh to try again.";
  }
  return "If this persists, check you're logged in with the esi-industry.read_character_jobs.v1 scope.";
}

/** A used/total slot pill, amber when full. */
function SlotPill({ label, slot }: { label: string; slot: Slot }) {
  const full = slot.used >= slot.total;
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm">
      <span className="text-zinc-400">{label}</span>{" "}
      <span
        className={`tabular-nums font-medium ${full ? "text-amber-400" : "text-zinc-100"}`}
      >
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
  if (r.status !== "active" || !r.endDate)
    return r.endDate?.slice(0, 16).replace("T", " ") || "—";
  const end = Date.parse(r.endDate);
  if (Number.isNaN(end)) return r.endDate;
  const ms = end - now;
  if (ms <= 0) return "ready";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}
