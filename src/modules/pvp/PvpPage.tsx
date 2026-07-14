import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { pvpProfiles, type PvpStats } from "../../lib/api";
import { formatInt } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";

/** Compact ISK (52.3B, 1.4M) for the dense stat grid. */
function iskShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return formatInt(n);
}

/** ISK efficiency: share of ISK you destroy vs total ISK swung. */
function efficiency(destroyed: number, lost: number): number {
  const total = destroyed + lost;
  return total > 0 ? Math.round((destroyed / total) * 100) : 0;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-emerald-400"
      : tone === "bad"
        ? "text-red-400"
        : "text-zinc-100";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      <span className={`text-sm ${color}`}>{value}</span>
    </div>
  );
}

function PilotCard({ p }: { p: PvpStats }) {
  const eff = efficiency(p.iskDestroyed, p.iskLost);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <a
          href={`https://zkillboard.com/character/${p.characterId}/`}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-zinc-100 hover:text-indigo-300"
        >
          {p.name}
        </a>
        <div className="flex items-center gap-2 text-[11px]">
          {!p.active && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500">
              inactive
            </span>
          )}
          <span
            className={`rounded px-1.5 py-0.5 ${
              p.dangerRatio >= 60
                ? "bg-red-950/50 text-red-300"
                : "bg-zinc-800 text-zinc-400"
            }`}
          >
            danger {p.dangerRatio}%
          </span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Destroyed"
          value={formatInt(p.shipsDestroyed)}
          tone="good"
        />
        <Stat label="Lost" value={formatInt(p.shipsLost)} tone="bad" />
        <Stat
          label="ISK destroyed"
          value={iskShort(p.iskDestroyed)}
          tone="good"
        />
        <Stat label="ISK lost" value={iskShort(p.iskLost)} tone="bad" />
        <Stat label="ISK efficiency" value={`${eff}%`} />
        <Stat label="Solo kills" value={formatInt(p.soloKills)} />
        <Stat label="Gang ratio" value={`${p.gangRatio}%`} />
        <Stat label="Solo losses" value={formatInt(p.soloLosses)} />
      </div>
    </div>
  );
}

export function PvpPage() {
  const [text, setText] = useState("");
  const scan = useMutation({ mutationFn: () => pvpProfiles(text) });
  const result = scan.data;

  return (
    <Page>
      <PageHeader
        title="PVP"
        subtitle="Paste pilot names → each one's kills, losses and threat from zKillboard."
      />
      <div className="mt-4 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste pilot names, one per line…"
          rows={5}
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-sm text-zinc-100 placeholder:text-zinc-600"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => scan.mutate()}
            disabled={scan.isPending || text.trim() === ""}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {scan.isPending ? "Profiling…" : "Profile pilots"}
          </button>
          {scan.isError && (
            <span className="text-sm text-red-400">
              Lookup failed — try again.
            </span>
          )}
        </div>
      </div>

      {result && (
        <div className="mt-4 flex flex-col gap-3">
          {result.pilots.length === 0 ? (
            <p className="text-sm text-zinc-500">No pilots resolved.</p>
          ) : (
            result.pilots.map((p) => <PilotCard key={p.characterId} p={p} />)
          )}
          {result.unresolved.length > 0 && (
            <p className="text-xs text-zinc-500">
              Couldn&apos;t resolve: {result.unresolved.join(", ")}
            </p>
          )}
        </div>
      )}
    </Page>
  );
}
