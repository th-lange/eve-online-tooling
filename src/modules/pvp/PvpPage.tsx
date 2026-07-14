import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  pvpProfiles,
  pvpPilotFits,
  type PvpStats,
  type LostFit,
} from "../../lib/api";
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

const SLOT_ORDER = ["high", "mid", "low", "rig", "subsystem", "drone"] as const;
const SLOT_LABEL: Record<string, string> = {
  high: "High",
  mid: "Mid",
  low: "Low",
  rig: "Rig",
  subsystem: "Sub",
  drone: "Drones",
};

/** ISO timestamp → local date string, or "" when absent/invalid. */
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** Metres → a compact km/m string. */
function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** A single lost fit: hull header (links to the kill) + modules by slot. */
function FitView({ fit }: { fit: LostFit }) {
  const last = fmtDate(fit.lastLost);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <a
          href={`https://zkillboard.com/kill/${fit.killmailId}/`}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-zinc-200 hover:text-indigo-300"
        >
          {fit.hullName}
        </a>
        <span className="text-[10px] text-zinc-500">
          {last ? `last ${last} · ` : ""}lost ×{formatInt(fit.lostCount)}
        </span>
      </div>
      <div className="mt-1 flex flex-col gap-0.5">
        {SLOT_ORDER.map((slot) => {
          const mods = fit.modules.filter((m) => m.slot === slot);
          if (mods.length === 0) return null;
          return (
            <div key={slot} className="flex gap-2 text-[11px]">
              <span className="w-12 shrink-0 text-zinc-600">
                {SLOT_LABEL[slot]}
              </span>
              <span className="text-zinc-300">
                {mods
                  .map((m) =>
                    m.quantity > 1 ? `${m.name} ×${m.quantity}` : m.name,
                  )
                  .join(", ")}
              </span>
            </div>
          );
        })}
      </div>
      {fit.analysis && (
        <div className="mt-2 border-t border-zinc-800/70 pt-2 text-[11px]">
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
            <span>
              EHP{" "}
              <span className="text-zinc-200">
                {formatInt(fit.analysis.ehp)}
              </span>
            </span>
            <span>
              DPS{" "}
              <span className="text-zinc-200">
                {formatInt(fit.analysis.dpsTotal)}
              </span>{" "}
              <span className="text-zinc-600">
                (t{formatInt(fit.analysis.dpsTurret)}/m
                {formatInt(fit.analysis.dpsMissile)}/d
                {formatInt(fit.analysis.dpsDrone)})
              </span>
            </span>
            {fit.analysis.scramRange != null && (
              <span>
                Scram{" "}
                <span className="text-amber-300">
                  {km(fit.analysis.scramRange)}
                </span>
              </span>
            )}
          </div>
          {fit.analysis.weapons.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {fit.analysis.weapons.map((w, i) => (
                <div key={`${w.name}-${i}`} className="flex gap-2">
                  <span className="w-12 shrink-0 text-zinc-600">Range</span>
                  <span className="text-zinc-300">
                    {w.name}: {km(w.optimal)}
                    {w.falloff > 0 ? ` +${km(w.falloff)} falloff` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-1 text-[10px] text-zinc-600">all-V estimate</div>
        </div>
      )}
    </div>
  );
}

/** Lazy "lost fits" section — fetches the pilot's killmail fits only when the
 * user expands it, so pasting many pilots stays cheap. */
function LostFits({ p }: { p: PvpStats }) {
  const [open, setOpen] = useState(false);
  const fits = useQuery({
    queryKey: ["pvp", "fits", p.characterId],
    queryFn: () => pvpPilotFits(p.characterId),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <div className="mt-3 border-t border-zinc-800 pt-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-indigo-400 hover:text-indigo-300"
      >
        {open ? "Hide lost fits" : "Show lost fits"}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {fits.isLoading && (
            <span className="text-xs text-zinc-500">Loading fits…</span>
          )}
          {fits.isError && (
            <span className="text-xs text-red-400">
              Couldn&apos;t load fits.
            </span>
          )}
          {fits.data && fits.data.length === 0 && (
            <span className="text-xs text-zinc-500">No recent losses.</span>
          )}
          {fits.data?.map((f) => (
            <FitView key={f.killmailId} fit={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function PilotCard({ p, topN }: { p: PvpStats; topN: number }) {
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
      {p.hulls.length > 0 && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          <span className="text-[10px] uppercase tracking-wide text-zinc-500">
            Flies (top {Math.min(topN, p.hulls.length)} by kills)
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.hulls.slice(0, topN).map((h) => (
              <span
                key={h.typeId}
                className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200"
              >
                {h.name}{" "}
                <span className="text-zinc-500">{formatInt(h.kills)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      <LostFits p={p} />
    </div>
  );
}

export function PvpPage() {
  const [text, setText] = useState("");
  const [topN, setTopN] = useState(5);
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
          {result.pilots.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>Top hulls:</span>
              {[5, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setTopN(n)}
                  className={`rounded px-2 py-0.5 ${
                    topN === n
                      ? "bg-indigo-600 text-white"
                      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
          {result.pilots.length === 0 ? (
            <p className="text-sm text-zinc-500">No pilots resolved.</p>
          ) : (
            result.pilots.map((p) => (
              <PilotCard key={p.characterId} p={p} topN={topN} />
            ))
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
