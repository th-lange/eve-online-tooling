import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, ExternalLink, SlidersHorizontal } from "lucide-react";
import {
  pvpProfiles,
  pvpPilotFits,
  pvpTypicalFit,
  pvpWeaponAmmo,
  onDpsTick,
  fittingListLocal,
  fittingSimulate,
  type PvpStats,
  type LostFit,
  type HullUsage,
  type WeaponLine,
  type AmmoLine,
  type DpsTick,
  type Fit,
  type WeaponRange,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { usePersistentState } from "../../lib/usePersistentState";
import { Page, PageHeader } from "../../components/page";
import { Stat } from "../../components/Stat";
import { useNavigate, useLocation } from "react-router-dom";
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
                {formatInt(Math.round(fit.analysis.dpsTotal))}
              </span>{" "}
              <span className="text-zinc-600">
                (t{formatInt(Math.round(fit.analysis.dpsTurret))}/m
                {formatInt(Math.round(fit.analysis.dpsMissile))}/d
                {formatInt(Math.round(fit.analysis.dpsDrone))})
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

  const hasAmmo = (ammo.data?.length ?? 0) > 0;
  const hasDps = ammo.data?.some((a) => a.dps > 0) ?? false;

  return (
    <div>
      <div
        className={`flex gap-2 ${hasAmmo || ammo.isLoading ? "cursor-pointer select-none" : ""}`}
        onMouseEnter={() => setOpen(true)}
        onClick={() => { if (hasAmmo) setOpen((o) => !o); }}
      >
        <span className="w-12 shrink-0 text-zinc-600">Range</span>
        <span
          className={`text-zinc-300 ${
            hasAmmo
              ? "underline decoration-dotted decoration-zinc-600 underline-offset-2"
              : ""
          }`}
        >
          {weapon.name}: {km(weapon.optimal)}
          {weapon.falloff > 0 ? ` → ${km(weapon.optimal + weapon.falloff)}` : ""}
        </span>
      </div>
      {open && ammo.isLoading && (
        <div className="ml-14 mt-1 mb-1">
          <span className="text-[10px] text-zinc-500">Loading…</span>
        </div>
      )}
      {open && hasAmmo && (
        <div className="ml-14 mt-1 mb-1">
          <table className="text-[10px] border-collapse">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left font-normal pr-3 pb-0.5">Ammo</th>
                <th className="text-right font-normal pr-3">Opt</th>
                <th className="text-right font-normal pr-3">Max</th>
                {hasDps && <th className="text-right font-normal pr-3">DPS</th>}
                <th className="font-normal">Dmg type</th>
              </tr>
            </thead>
            <tbody>
              {ammo.data!.map((a) => (
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
                    {a.falloff > 0 ? km(a.optimal + a.falloff) : "—"}
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
  const location = useLocation();
  const navPilot =
    (location.state as { pilotName?: string } | null)?.pilotName ?? "";
  const [text, setText] = useState(navPilot);
  const [fitLimit, setFitLimit] = useState(5);
  const scan = useMutation({ mutationFn: () => pvpProfiles(text) });
  const result = scan.data;

  // --- Fight scanner ---
  const [fightScanOn, setFightScanOn] = usePersistentState<boolean>(
    "pvp.fightScan",
    false,
  );
  const [fightTicks, setFightTicks] = useState<DpsTick[]>([]);
  const [fightDismissed, setFightDismissed] = useState(false);
  const [selectedFitId, setSelectedFitId] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!fightScanOn) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setFightTicks([]);
      return;
    }
    let cancelled = false;
    onDpsTick((tick) => {
      if (!cancelled)
        setFightTicks((prev) => [...prev, tick].slice(-120));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [fightScanOn]);

  const latestTick = fightTicks[fightTicks.length - 1];
  const latestAt = latestTick?.at ?? 0;

  // Active attackers: pilots dealing incoming damage in the last 15 seconds.
  const activeAttackers = useMemo(() => {
    const seen = new Map<string, { dpsIn: number; lastAt: number }>();
    for (const tick of fightTicks) {
      for (const p of tick.byPilot) {
        if (p.dpsIn > 0) {
          const ex = seen.get(p.name);
          seen.set(p.name, {
            dpsIn: p.dpsIn,
            lastAt: Math.max(tick.at, ex?.lastAt ?? 0),
          });
        }
      }
    }
    const cutoff = latestAt - 15;
    return [...seen.entries()]
      .filter(([, { lastAt }]) => lastAt > cutoff)
      .map(([name, { dpsIn }]) => ({ name, dpsIn }));
  }, [fightTicks, latestAt]);

  // Auto-reset dismissed state once fight ends so the next one auto-shows.
  useEffect(() => {
    if (activeAttackers.length === 0) setFightDismissed(false);
  }, [activeAttackers.length]);

  const fightActive =
    fightScanOn && activeAttackers.length > 0 && !fightDismissed;

  // Fit data for "my ranges" in the fight panel.
  const localFits = useQuery({
    queryKey: ["fitting", "local"],
    queryFn: fittingListLocal,
    staleTime: 30_000,
    enabled: fightScanOn,
  });
  const selectedFit =
    localFits.data?.find((f) => f.id === selectedFitId) ?? null;
  const fitStats = useQuery({
    queryKey: ["pvp", "fight-fit-stats", selectedFitId],
    queryFn: () => fittingSimulate(selectedFit!),
    enabled: selectedFit != null,
    staleTime: Infinity,
  });

  // When arriving via attacker-click from Local Intel, auto-scan the pre-filled name.
  useEffect(() => {
    if (navPilot && !scan.isPending) scan.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount only
  return (
    <>
      <Page>
        <PageHeader
          title="PVP"
          subtitle="Paste pilot names → each one's kills, losses and threat from zKillboard."
          actions={
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={fightScanOn}
                onChange={(e) => setFightScanOn(e.currentTarget.checked)}
              />
              Scan logs for fights
            </label>
          }
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

      {fightActive && (
        <FightPanel
          ticks={fightTicks}
          attackers={activeAttackers}
          myWeapons={latestTick?.byWeapon ?? []}
          localFits={localFits.data ?? []}
          selectedFitId={selectedFitId}
          onSelectFit={setSelectedFitId}
          fitWeaponRanges={fitStats.data?.weaponRanges ?? []}
          onDismiss={() => setFightDismissed(true)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- Fight panel

/** Mini rolling DPS chart (dpsOut green, dpsIn red) from accumulated ticks. */
function MiniDpsChart({ ticks }: { ticks: DpsTick[] }) {
  if (ticks.length < 2) return <div className="h-12 w-full rounded bg-zinc-950" />;
  const W = 100, H = 48, pad = 2;
  const w = W - pad * 2, h = H - pad * 2;
  const maxVal = Math.max(
    1,
    ...ticks.flatMap((t) => [t.dpsOut, t.dpsIn]),
  );
  const x = (i: number) => pad + (i / (ticks.length - 1)) * w;
  const y = (v: number) => pad + h - (v / maxVal) * h;
  const path = (field: "dpsOut" | "dpsIn") =>
    ticks.map((t, i) => `${x(i).toFixed(1)},${y(t[field]).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
      <rect width={W} height={H} fill="#09090b" rx="3" />
      <polyline
        points={path("dpsOut")}
        fill="none"
        stroke="#34d399"
        strokeWidth="1.5"
      />
      <polyline
        points={path("dpsIn")}
        fill="none"
        stroke="#f87171"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** One attacker in the fight panel: auto-fetches their zKill profile + recent
 *  fit to show their weapons and engagement ranges. */
function AttackerCard({
  name,
  dpsIn,
}: {
  name: string;
  dpsIn: number;
}) {
  const profile = useQuery({
    queryKey: ["pvp", "profile-name", name],
    queryFn: () => pvpProfiles(name),
    staleTime: 5 * 60_000,
  });
  const charId = profile.data?.pilots[0]?.characterId;
  const fits = useQuery({
    queryKey: ["pvp", "fits", charId],
    queryFn: () => pvpPilotFits(charId!),
    enabled: charId != null,
    staleTime: Infinity,
  });

  // Turret weapons with falloff from their most recent fit.
  const weapons = useMemo(
    () =>
      (fits.data?.[0]?.analysis?.weapons ?? []).filter(
        (w) => (w.tracking ?? 0) > 0 && w.falloff > 0,
      ),
    [fits.data],
  );

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-100">{name}</span>
        <span className="text-xs text-rose-400">
          {Math.round(dpsIn)} dps in
        </span>
        {fits.data?.[0] && (
          <span className="text-xs text-zinc-500">
            ({fits.data[0].hullName})
          </span>
        )}
        {profile.isLoading && (
          <span className="text-[10px] text-zinc-600">looking up…</span>
        )}
      </div>
      {weapons.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {weapons.map((w, i) => (
            <span
              key={i}
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
              title={w.name}
            >
              {w.name}: {km(w.optimal)}
              {w.falloff > 0 ? ` → ${km(w.optimal + w.falloff)}` : ""}
            </span>
          ))}
        </div>
      )}
      {fits.isLoading && (
        <div className="mt-1 text-[10px] text-zinc-600">Loading fits…</div>
      )}
    </div>
  );
}

/** Fixed bottom-of-screen panel that appears when a fight is detected. */
function FightPanel({
  ticks,
  attackers,
  myWeapons,
  localFits,
  selectedFitId,
  onSelectFit,
  fitWeaponRanges,
  onDismiss,
}: {
  ticks: DpsTick[];
  attackers: { name: string; dpsIn: number }[];
  myWeapons: { name: string; dps: number }[];
  localFits: Fit[];
  selectedFitId: string | null;
  onSelectFit: (id: string | null) => void;
  fitWeaponRanges: WeaponRange[];
  onDismiss: () => void;
}) {
  const latestTick = ticks[ticks.length - 1];
  // Unique weapon ranges (deduped by optimal+falloff — all copies of the same
  // weapon type have identical ranges, so one representative is enough).
  const uniqueRanges = useMemo(() => {
    const seen = new Set<string>();
    return fitWeaponRanges.filter((r) => {
      const key = `${r.optimal}:${r.falloff}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [fitWeaponRanges]);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-rose-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
            Active Fight
          </span>
          {latestTick && (
            <span className="text-xs text-zinc-400">
              In{" "}
              <span className="tabular-nums text-rose-400">
                {Math.round(latestTick.dpsIn)}
              </span>{" "}
              · Out{" "}
              <span className="tabular-nums text-emerald-400">
                {Math.round(latestTick.dpsOut)}
              </span>{" "}
              dps
            </span>
          )}
          <span className="text-xs text-zinc-600">
            Requires DPS meter running in the background
          </span>
        </div>
        <button
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Dismiss ✕
        </button>
      </div>

      {/* Content: 3-column grid */}
      <div
        className="grid grid-cols-3 gap-4 overflow-y-auto p-4"
        style={{ maxHeight: 260 }}
      >
        {/* ── My Weapons ── */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            My weapons
          </h3>
          {/* What's firing now (from DPS log) */}
          {myWeapons.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {myWeapons.map((w, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="flex-1 truncate text-zinc-300">{w.name}</span>
                  <span className="shrink-0 tabular-nums text-emerald-400">
                    {Math.round(w.dps)} dps
                  </span>
                </div>
              ))}
            </div>
          )}
          {/* Fit selector for ranges */}
          <select
            value={selectedFitId ?? ""}
            onChange={(e) => onSelectFit(e.currentTarget.value || null)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
          >
            <option value="">
              {localFits.length > 0
                ? "Select fit for ranges…"
                : "No saved fits found"}
            </option>
            {localFits.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          {uniqueRanges.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {uniqueRanges.map((r, i) => (
                <div key={i} className="text-xs text-zinc-400">
                  <span className="text-zinc-300">{km(r.optimal)}</span>
                  {r.falloff > 0 && (
                    <> → <span className="text-zinc-300">{km(r.optimal + r.falloff)}</span></>
                  )}
                  <span className="ml-1 text-zinc-600">opt → max</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Attackers ── */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Attackers ({attackers.length})
          </h3>
          <div className="flex flex-col gap-2">
            {attackers.map((a) => (
              <AttackerCard key={a.name} name={a.name} dpsIn={a.dpsIn} />
            ))}
          </div>
        </div>

        {/* ── DPS Graph ── */}
        <div className="flex flex-col gap-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            DPS
          </h3>
          <MiniDpsChart ticks={ticks} />
          <div className="flex gap-3 text-[10px] text-zinc-600">
            <span>
              <span className="text-emerald-500">▬</span> out
            </span>
            <span>
              <span className="text-rose-500">▬</span> in
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
