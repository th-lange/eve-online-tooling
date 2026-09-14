import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  pvpProfiles,
  pvpPilotFits,
  onDpsTick,
  fittingListLocal,
  fittingSimulate,
  type DpsTick,
  type Fit,
  type WeaponRange,
} from "../../lib/api";
import { usePersistentState } from "../../lib/usePersistentState";
import { FightOverlayContext } from "./fightOverlayContext";

/** Metres → compact km/m string. Used in AttackerCard and FightPanel. */
function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

// ---------------------------------------------------------------- MiniDpsChart

/** Mini rolling DPS chart (dpsOut green, dpsIn red) from accumulated ticks. */
function MiniDpsChart({ ticks }: { ticks: DpsTick[] }) {
  if (ticks.length < 2)
    return <div className="h-12 w-full rounded bg-zinc-950" />;
  const W = 100,
    H = 48,
    pad = 2;
  const w = W - pad * 2,
    h = H - pad * 2;
  const maxVal = Math.max(1, ...ticks.flatMap((t) => [t.dpsOut, t.dpsIn]));
  const x = (i: number) => pad + (i / (ticks.length - 1)) * w;
  const y = (v: number) => pad + h - (v / maxVal) * h;
  const path = (field: "dpsOut" | "dpsIn") =>
    ticks
      .map((t, i) => `${x(i).toFixed(1)},${y(t[field]).toFixed(1)}`)
      .join(" ");
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

// ---------------------------------------------------------------- AttackerCard

/** One attacker in the fight panel.
 *  - Live data (instant): ship type + weapon names from the combat log.
 *  - Supplemental (async): zKill profile → most-recent fit → weapon ranges. */
function AttackerCard({
  name,
  dpsIn,
  liveShip,
  liveWeapons,
}: {
  name: string;
  dpsIn: number;
  liveShip?: string;
  liveWeapons?: string[];
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

  // zKill turret ranges from their most recent lost fit (supplements live data).
  const zkillWeapons = useMemo(
    () =>
      (fits.data?.[0]?.analysis?.weapons ?? []).filter(
        (w) => (w.tracking ?? 0) > 0 && w.falloff > 0,
      ),
    [fits.data],
  );

  // Live log data is authoritative; fall back to zKill hull name while waiting.
  const shipLabel =
    liveShip ?? fits.data?.[0]?.hullName ?? (profile.isLoading ? "…" : null);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-100">{name}</span>
        <span className="tabular-nums text-xs text-rose-400">
          {Math.round(dpsIn)} dps in
        </span>
        {shipLabel && (
          <span className="text-xs text-zinc-400">{shipLabel}</span>
        )}
      </div>

      {/* Live weapons from the combat log — shown immediately */}
      {liveWeapons && liveWeapons.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {liveWeapons.map((w, i) => (
            <span
              key={i}
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300"
            >
              {w}
            </span>
          ))}
        </div>
      )}

      {/* zKill ranges: show once available, adds opt → max to the weapon name */}
      {zkillWeapons.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {zkillWeapons.map((w, i) => (
            <span
              key={i}
              className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500"
              title="from zKill most-recent fit"
            >
              {w.name}: {km(w.optimal)}
              {w.falloff > 0 ? ` → ${km(w.optimal + w.falloff)}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- FightPanel

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
  attackers: {
    name: string;
    dpsIn: number;
    ship?: string;
    weapons: string[];
  }[];
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
                  <span className="flex-1 truncate text-zinc-300">
                    {w.name}
                  </span>
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
                    <>
                      {" "}
                      →{" "}
                      <span className="text-zinc-300">
                        {km(r.optimal + r.falloff)}
                      </span>
                    </>
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
              <AttackerCard
                key={a.name}
                name={a.name}
                dpsIn={a.dpsIn}
                liveShip={a.ship}
                liveWeapons={a.weapons}
              />
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

// ---------------------------------------------------------- FightOverlayProvider

/**
 * Root-level provider that owns the fight overlay toggle and scanning state.
 * Mounted at the app root so the `FightPanel` renders outside any module's
 * `display:none` wrapper — it stays visible no matter which module is active.
 *
 * The `"pvp.fightScan"` key is shared with the PVP page's toggle so existing
 * user preferences carry over without a migration.
 */
export function FightOverlayProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = usePersistentState<boolean>(
    "pvp.fightScan",
    false,
  );
  const [fightTicks, setFightTicks] = useState<DpsTick[]>([]);
  const [fightDismissed, setFightDismissed] = useState(false);
  const [selectedFitId, setSelectedFitId] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setFightTicks([]);
      return;
    }
    let cancelled = false;
    onDpsTick((tick) => {
      if (!cancelled) setFightTicks((prev) => [...prev, tick].slice(-120));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [enabled]);

  const latestTick = fightTicks[fightTicks.length - 1];
  const latestAt = latestTick?.at ?? 0;

  // Active attackers: player pilots dealing incoming damage in the last 15 s.
  // NPCs are filtered by requiring `ship` — EVE always emits `(SHIP)` for
  // player characters in gamelogs; NPCs omit it.
  const activeAttackers = useMemo(() => {
    const seen = new Map<
      string,
      { dpsIn: number; lastAt: number; ship?: string; weapons: string[] }
    >();
    for (const tick of fightTicks) {
      for (const p of tick.byPilot) {
        if (p.dpsIn > 0) {
          const ex = seen.get(p.name);
          seen.set(p.name, {
            dpsIn: p.dpsIn,
            lastAt: Math.max(tick.at, ex?.lastAt ?? 0),
            // Live log data: ship is authoritative; accumulate unique weapons.
            ship: p.ship ?? ex?.ship,
            weapons: ex
              ? [
                  ...ex.weapons,
                  ...(p.weapons ?? []).filter((w) => !ex.weapons.includes(w)),
                ]
              : (p.weapons ?? []),
          });
        }
      }
    }
    const cutoff = latestAt - 15;
    return [...seen.entries()]
      .filter(([, { lastAt, ship }]) => lastAt > cutoff && ship !== undefined)
      .map(([name, { dpsIn, ship, weapons }]) => ({
        name,
        dpsIn,
        ship,
        weapons,
      }));
  }, [fightTicks, latestAt]);

  // Auto-reset dismissed state once fight ends so the next one auto-shows.
  useEffect(() => {
    if (activeAttackers.length === 0) setFightDismissed(false);
  }, [activeAttackers.length]);

  const fightActive = enabled && activeAttackers.length > 0 && !fightDismissed;

  // Fit data for "my ranges" in the fight panel.
  const localFits = useQuery({
    queryKey: ["fitting", "local"],
    queryFn: fittingListLocal,
    staleTime: 30_000,
    enabled,
  });
  const selectedFit =
    localFits.data?.find((f) => f.id === selectedFitId) ?? null;
  const fitStats = useQuery({
    queryKey: ["pvp", "fight-fit-stats", selectedFitId],
    queryFn: () => fittingSimulate(selectedFit!),
    enabled: selectedFit != null,
    staleTime: Infinity,
  });

  return (
    <FightOverlayContext.Provider value={{ enabled, setEnabled }}>
      {children}
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
    </FightOverlayContext.Provider>
  );
}
