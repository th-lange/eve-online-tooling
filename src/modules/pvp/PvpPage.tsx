import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, SlidersHorizontal } from "lucide-react";
import {
  pvpProfiles,
  pvpPilotFits,
  pvpTypicalFit,
  pvpWeaponAmmo,
  type PvpStats,
  type LostFit,
  type HullUsage,
  type WeaponLine,
  type AmmoLine,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { Page, PageHeader } from "../../components/page";
import { Stat } from "../../components/Stat";
import { useNavigate } from "react-router-dom";
import { openFitInFitting } from "../../lib/deepLink";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import {
  classifyArchetype,
  ARCHETYPE_LABEL,
  ARCHETYPE_CLASS,
} from "../../lib/shipArchetype";

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
function FitView({ fit, community }: { fit: LostFit; community?: boolean }) {
  const navigate = useNavigate();
  const { copied, copy } = useCopyToClipboard();
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
          {community
            ? "typical · community"
            : `${last ? `last ${last} · ` : ""}lost ×${formatInt(fit.lostCount)}`}
        </span>
      </div>
      <div className="mt-1.5 flex gap-2">
        <button
          type="button"
          onClick={() => copy(fit.eft, "eft")}
          className="flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <Copy size={10} /> {copied === "eft" ? "Copied" : "Copy EFT"}
        </button>
        <button
          type="button"
          onClick={() => {
            openFitInFitting(fit.eft);
            navigate("/fitting");
          }}
          title="Load this fit in the Fitting module to simulate it"
          className="flex items-center gap-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <SlidersHorizontal size={10} /> Simulate
        </button>
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
            {fit.analysis.maxVelocity > 0 && (
              <span>
                Speed{" "}
                <span
                  className={
                    fit.analysis.hasProp ? "text-sky-300" : "text-zinc-200"
                  }
                >
                  {formatInt(Math.round(fit.analysis.maxVelocity))} m/s
                </span>
                {fit.analysis.hasProp && (
                  <span className="text-zinc-500"> prop</span>
                )}
              </span>
            )}
            {fit.analysis.lockRange > 0 && (
              <span>
                Lock{" "}
                <span className="text-zinc-200">
                  {km(fit.analysis.lockRange)}
                </span>
              </span>
            )}
          </div>
          {(() => {
            const arch = classifyArchetype(fit.analysis.weapons);
            return arch ? (
              <div className="mt-1.5">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${ARCHETYPE_CLASS[arch]}`}
                >
                  {ARCHETYPE_LABEL[arch]}
                </span>
              </div>
            ) : null;
          })()}
          {fit.analysis.weapons.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {fit.analysis.weapons.map((w, i) => (
                <WeaponRow
                  key={`${w.typeId}-${i}`}
                  weapon={w}
                  shipTypeId={fit.hullTypeId}
                />
              ))}
            </div>
          )}
          <div className="mt-1 text-[10px] text-zinc-600">all-V estimate</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- WeaponRow

/** Damage-type colour for the bar segments. */
const DMG_CLASS: Record<string, string> = {
  em: "bg-sky-400",
  therm: "bg-orange-400",
  kin: "bg-zinc-400",
  exp: "bg-amber-400",
};

function DmgBar({ em, therm, kin, exp }: Pick<AmmoLine, "em" | "therm" | "kin" | "exp">) {
  const segs = [
    { key: "em", v: em, label: "EM" },
    { key: "therm", v: therm, label: "Th" },
    { key: "kin", v: kin, label: "Kin" },
    { key: "exp", v: exp, label: "Exp" },
  ].filter((s) => s.v > 0.01);
  if (segs.length === 0) return null;
  return (
    <div className="flex h-1.5 w-20 overflow-hidden rounded-full">
      {segs.map((s) => (
        <div
          key={s.key}
          title={`${s.label} ${Math.round(s.v * 100)}%`}
          className={DMG_CLASS[s.key]}
          style={{ width: `${s.v * 100}%` }}
        />
      ))}
    </div>
  );
}

/**
 * One weapon line: shows its current range, and on hover fires a lazy query
 * for T2 ammo variants, expanding an inline comparison table.
 */
function WeaponRow({
  weapon,
  shipTypeId,
}: {
  weapon: WeaponLine;
  shipTypeId: number;
}) {
  const [open, setOpen] = useState(false);
  const ammo = useQuery({
    queryKey: ["pvp", "ammo", weapon.typeId, shipTypeId],
    queryFn: () => pvpWeaponAmmo(weapon.typeId, shipTypeId),
    enabled: open,
    staleTime: Infinity,
  });

  const hasDps = ammo.data?.some((a) => a.dps > 0) ?? false;

  return (
    <div>
      <div
        className="flex gap-2 cursor-pointer select-none"
        onMouseEnter={() => setOpen(true)}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="w-12 shrink-0 text-zinc-600">Range</span>
        <span className="text-zinc-300 underline decoration-dotted decoration-zinc-600 underline-offset-2">
          {weapon.name}: {km(weapon.optimal)}
          {weapon.falloff > 0 ? ` +${km(weapon.falloff)} falloff` : ""}
        </span>
      </div>
      {open && (
        <div className="ml-14 mt-1 mb-1">
          {ammo.isLoading && (
            <span className="text-[10px] text-zinc-500">Loading ammo…</span>
          )}
          {ammo.data && ammo.data.length === 0 && (
            <span className="text-[10px] text-zinc-600">No T2 ammo found.</span>
          )}
          {ammo.data && ammo.data.length > 0 && (
            <table className="text-[10px] border-collapse">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left font-normal pr-3 pb-0.5">Ammo</th>
                  <th className="text-right font-normal pr-3">Opt</th>
                  <th className="text-right font-normal pr-3">Falloff</th>
                  {hasDps && <th className="text-right font-normal pr-3">DPS</th>}
                  <th className="font-normal">Dmg type</th>
                </tr>
              </thead>
              <tbody>
                {ammo.data.map((a) => (
                  <tr
                    key={a.typeId}
                    className={`border-t border-zinc-800/60 ${
                      a.typeId === weapon.typeId
                        ? "text-zinc-200"
                        : "text-zinc-400"
                    }`}
                  >
                    <td className="pr-3 py-0.5">
                      {a.name}
                      {a.typeId === weapon.typeId && (
                        <span className="ml-1 text-zinc-600">✓</span>
                      )}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{km(a.optimal)}</td>
                    <td className="pr-3 text-right tabular-nums">
                      {a.falloff > 0 ? km(a.falloff) : "—"}
                    </td>
                    {hasDps && (
                      <td className="pr-3 text-right tabular-nums">
                        {a.dps > 0 ? a.dps.toFixed(0) : "—"}
                      </td>
                    )}
                    <td><DmgBar em={a.em} therm={a.therm} kin={a.kin} exp={a.exp} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/** A hull the pilot flies but we've not seen them lose: lazily loads a typical
 * (community) fit for that ship type. */
function TypicalFit({ hull }: { hull: HullUsage }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["pvp", "typical", hull.typeId],
    queryFn: () => pvpTypicalFit(hull.typeId),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="self-start text-xs text-zinc-400 hover:text-zinc-200"
      >
        {open ? "−" : "+"} {hull.name}{" "}
        <span className="text-zinc-600">typical fit</span>
      </button>
      {open &&
        (q.isLoading ? (
          <span className="text-xs text-zinc-500">Loading…</span>
        ) : q.data ? (
          <FitView fit={q.data} community />
        ) : (
          <span className="text-xs text-zinc-500">No community fit found.</span>
        ))}
    </div>
  );
}

/** Lazy "lost fits" section — fetches the pilot's killmail fits only when the
 * user expands it, so pasting many pilots stays cheap. */
function LostFits({ p, fitLimit }: { p: PvpStats; fitLimit: number }) {
  const [open, setOpen] = useState(false);
  const fits = useQuery({
    queryKey: ["pvp", "fits", p.characterId],
    queryFn: () => pvpPilotFits(p.characterId),
    enabled: open,
    staleTime: Infinity,
  });
  const flownNotLost: HullUsage[] = fits.data
    ? (() => {
        const lost = new Set(fits.data.map((f) => f.hullTypeId));
        return p.hulls.filter((h) => !lost.has(h.typeId));
      })()
    : [];
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
          {fits.data?.slice(0, fitLimit).map((f) => (
            <FitView key={f.killmailId} fit={f} />
          ))}
          {fits.data && fits.data.length > fitLimit && (
            <span className="text-[11px] text-zinc-600">
              +{fits.data.length - fitLimit} more (raise the limit above).
            </span>
          )}
          {flownNotLost.length > 0 && (
            <div className="mt-1 flex flex-col gap-1 border-t border-zinc-800/60 pt-2">
              <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                Flies but no loss seen — typical (community) fits
              </span>
              {flownNotLost.map((h) => (
                <TypicalFit key={h.typeId} hull={h} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PilotCard({ p, fitLimit }: { p: PvpStats; fitLimit: number }) {
  const eff = efficiency(p.iskDestroyed, p.iskLost);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <a
          href={`https://zkillboard.com/character/${p.characterId}/`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-sm font-medium text-zinc-100 hover:text-indigo-300"
          title="Open on zKillboard"
        >
          {p.name}
          <ExternalLink size={11} className="opacity-60" />
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
          dense
          accent="text-emerald-400"
        />
        <Stat
          label="Lost"
          value={formatInt(p.shipsLost)}
          dense
          accent="text-red-400"
        />
        <Stat
          label="ISK destroyed"
          value={iskShort(p.iskDestroyed)}
          dense
          accent="text-emerald-400"
        />
        <Stat
          label="ISK lost"
          value={iskShort(p.iskLost)}
          dense
          accent="text-red-400"
        />
        <Stat label="ISK efficiency" value={`${eff}%`} dense />
        <Stat label="Solo kills" value={formatInt(p.soloKills)} dense />
        <Stat label="Gang ratio" value={`${p.gangRatio}%`} dense />
        <Stat label="Solo losses" value={formatInt(p.soloLosses)} dense />
      </div>
      <div className="mt-3 border-t border-zinc-800 pt-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          Flies (by kills)
        </span>
        {p.hulls.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {p.hulls.map((h) => (
              <span
                key={h.typeId}
                className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200"
              >
                {h.name}{" "}
                <span className="text-zinc-500">{formatInt(h.kills)}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-zinc-600">
            No flown-ship data from zKill — they may fly ships they haven&apos;t
            killed in; check their lost fits.
          </p>
        )}
      </div>
      <LostFits p={p} fitLimit={fitLimit} />
    </div>
  );
}

export function PvpPage() {
  const [text, setText] = useState("");
  const [fitLimit, setFitLimit] = useState(5);
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
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!scan.isPending && text.trim() !== "") scan.mutate();
            }
          }}
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
          <span className="text-xs text-zinc-500">
            Enter to submit · Shift+Enter for a new line
          </span>
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
              <span>Lost fits per pilot:</span>
              {[5, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => setFitLimit(n)}
                  className={`rounded px-2 py-0.5 ${
                    fitLimit === n
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
              <PilotCard key={p.characterId} p={p} fitLimit={fitLimit} />
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
