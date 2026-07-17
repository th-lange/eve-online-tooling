import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  characterFleet,
  characterMining,
  characterResearch,
  characterSkills,
  characterStandings,
  errorMessage,
  isAuthRequired,
} from "../../lib/api";
import { formatInt, formatIsk } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";
import { Stat } from "../../components/Stat";

type Tab = "skills" | "standings" | "research" | "mining" | "fleet";

const TITLE = "Character";
const SUBTITLE =
  "Skills, standings and R&D research for your first logged-in character.";

export function CharacterPage() {
  const [tab, setTab] = useState<Tab>("skills");
  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <Tabs tab={tab} onChange={setTab} />
      <div className="mt-3">
        {tab === "skills" && <Skills />}
        {tab === "standings" && <Standings />}
        {tab === "research" && <Research />}
        {tab === "mining" && <Mining />}
        {tab === "fleet" && <Fleet />}
      </div>
    </Page>
  );
}

function Skills() {
  const q = useQuery({
    queryKey: ["char", "skills"],
    queryFn: characterSkills,
  });
  if (q.isError) return <Err e={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div>
      <div className="mb-3 flex gap-6 text-sm">
        <Stat label="Total SP" value={formatInt(d.totalSp)} />
        <Stat label="Unallocated SP" value={formatInt(d.unallocatedSp)} />
        <Stat label="Skills trained" value={formatInt(d.trainedCount)} />
      </div>
      <h3 className="text-sm font-medium text-zinc-300">Training queue</h3>
      <div className="mt-1 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Skill</th>
              <th className="px-3 py-2 text-right font-medium">Level</th>
              <th className="px-3 py-2 text-right font-medium">Finishes</th>
            </tr>
          </thead>
          <tbody>
            {d.queue.map((s, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">{s.skillName}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {s.level}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {s.finishDate ? until(s.finishDate) : "—"}
                </td>
              </tr>
            ))}
            {d.queue.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-zinc-500">
                  Queue empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Standings() {
  const q = useQuery({
    queryKey: ["char", "standings"],
    queryFn: characterStandings,
  });
  if (q.isError) return <Err e={q.error} />;
  if (!q.data) return <Loading />;
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Toward</th>
            <th className="px-3 py-2 text-left font-medium">Type</th>
            <th className="px-3 py-2 text-right font-medium">Base</th>
            <th className="px-3 py-2 text-right font-medium">Effective</th>
            <th className="px-3 py-2 text-left font-medium">Skill</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((s, i) => (
            <tr key={i} className="border-t border-zinc-800 text-zinc-300">
              <td className="px-3 py-1.5 text-zinc-200">{s.name}</td>
              <td className="px-3 py-1.5 text-zinc-500">{s.fromType}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">
                {s.base.toFixed(2)}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  s.effective >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {s.effective.toFixed(2)}
              </td>
              <td className="px-3 py-1.5 text-zinc-500">{s.skill}</td>
            </tr>
          ))}
          {q.data.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-4 text-center text-zinc-500">
                No standings.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Research() {
  const q = useQuery({
    queryKey: ["char", "research"],
    queryFn: characterResearch,
  });
  if (q.isError) return <Err e={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div>
      <div className="mb-3 flex gap-6 text-sm">
        <Stat label="Banked RP" value={formatInt(Math.round(d.totalPoints))} />
        <Stat label="RP / day" value={formatInt(Math.round(d.pointsPerDay))} />
      </div>
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Agent</th>
              <th className="px-3 py-2 text-left font-medium">Skill</th>
              <th className="px-3 py-2 text-right font-medium">RP/day</th>
              <th className="px-3 py-2 text-right font-medium">Banked RP</th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">{r.agent}</td>
                <td className="px-3 py-1.5 text-zinc-400">{r.skill}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {formatInt(Math.round(r.pointsPerDay))}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.currentPoints))}
                </td>
              </tr>
            ))}
            {d.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-zinc-500">
                  No R&amp;D agents.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Mining() {
  const q = useQuery({
    queryKey: ["char", "mining"],
    queryFn: characterMining,
  });
  if (q.isError) return <Err e={q.error} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div>
      <div className="mb-3 grid grid-cols-3 gap-4 text-sm">
        <Window label="24h" units={d.units24h} value={d.value24h} />
        <Window label="7d" units={d.units7d} value={d.value7d} />
        <Window label="30d" units={d.units30d} value={d.value30d} />
      </div>
      {d.systems.length > 0 && (
        <div className="mb-2 text-xs text-zinc-500">
          Recent systems: {d.systems.join(", ")}
        </div>
      )}
      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Ore (30d)</th>
              <th className="px-3 py-2 text-right font-medium">Units</th>
              <th className="px-3 py-2 text-right font-medium">
                Value (Jita buy)
              </th>
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">{r.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {formatInt(r.quantity)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                  {formatIsk(r.value)}
                </td>
              </tr>
            ))}
            {d.rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-zinc-500">
                  No mining in the last 30 days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Fleet() {
  const q = useQuery({ queryKey: ["char", "fleet"], queryFn: characterFleet });
  if (q.isError) return <Err e={q.error} />;
  if (!q.data) return <Loading />;
  if (!q.data.inFleet) {
    return (
      <div className="p-8 text-center text-sm text-zinc-500">
        Not in a fleet.
      </div>
    );
  }
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Member</th>
            <th className="px-3 py-2 text-left font-medium">Ship</th>
            <th className="px-3 py-2 text-left font-medium">System</th>
            <th className="px-3 py-2 text-left font-medium">Role</th>
          </tr>
        </thead>
        <tbody>
          {q.data.members.map((m, i) => (
            <tr key={i} className="border-t border-zinc-800 text-zinc-300">
              <td className="px-3 py-1.5 text-zinc-200">{m.name}</td>
              <td className="px-3 py-1.5">{m.ship}</td>
              <td className="px-3 py-1.5 text-zinc-400">{m.system}</td>
              <td className="px-3 py-1.5 text-zinc-500">{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Window({
  label,
  units,
  value,
}: {
  label: string;
  units: number;
  value: number;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="tabular-nums text-zinc-200">{formatInt(units)} units</div>
      <div className="tabular-nums text-emerald-400">{formatIsk(value)}</div>
    </div>
  );
}

function until(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "done";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "skills", label: "Skills" },
    { value: "standings", label: "Standings" },
    { value: "research", label: "Research" },
    { value: "mining", label: "Mining" },
    { value: "fleet", label: "Fleet" },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Loading() {
  return <div className="p-8 text-center text-sm text-zinc-500">Loading…</div>;
}
function Err({ e }: { e: unknown }) {
  // Auth-required is a normal empty state, not a failure — show a calm prompt
  // rather than a red error string (#337).
  if (isAuthRequired(e)) {
    return (
      <div className="p-6 text-sm text-zinc-400">
        Log in a character first to view this.
      </div>
    );
  }
  return (
    <div className="p-6 text-sm text-rose-400">
      {errorMessage(e)} — check the required scope is enabled on your EVE app.
    </div>
  );
}
