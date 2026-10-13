import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  pvpProfiles,
  characterShip,
  pvpPilotFits,
  onDpsBuckets,
  onDpsEvents,
  dpsStart,
  fittingListLocal,
  fittingSimulate,
  type DpsBucket,
  type DpsEvent,
  type Fit,
  type WeaponRange,
  type CharacterShip,
} from "../../lib/api";
import { usePersistentState } from "../../lib/usePersistentState";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { playCue, type CueSound } from "../../lib/sound";
import { FIGHT_OVERLAY_SHIP_POLL_INTERVAL_MS } from "../../lib/refreshIntervals";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { Modal } from "../../components/Modal";
import { CombatLogPanel } from "../dpsmeter/CombatLogPanel";
import {
  BUCKET_SECS,
  appendEvents,
  bucketStartOf,
  smoothSeries,
} from "../dpsmeter/dpsMeterShared";
import { FightOverlayContext } from "./fightOverlayContext";

/** Metres → compact km/m string. Used in AttackerCard and FightPanel. */
function km(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** Whether a bucket shows live combat: damage dealt/taken, or active tackle.
 *  The overlay stops accumulating once combat ends, so the chart freezes on
 *  the fight instead of scrolling an empty grid as the idle capture keeps
 *  emitting empty buckets. Exported for tests. */
export function isCombatBucket(b: DpsBucket): boolean {
  return (
    b.damageOut > 0 ||
    b.damageIn > 0 ||
    b.byPilot.some((p) => p.scramIn || p.pointIn || p.scramOut || p.pointOut)
  );
}

/** Overlay bucket-buffer reducer (#986): begin on the first combat bucket,
 *  keep appending while the fight is live (capped at 120 buckets = 10 min,
 *  incl. the final empty wind-down bucket), then freeze after **one empty
 *  bucket** (5 s of silence) — and **stay** frozen, no matter what arrives
 *  next, until the caller explicitly clears the buffer (the panel's Dismiss
 *  button). That only-Dismiss-resets rule is #950: a stray quiet moment
 *  between volleys must never silently throw the collected fight away; on
 *  the 5 s grid a quiet moment is a whole empty bucket, which is also the
 *  freeze signal — so the freeze keeps the fight ON screen, and resumption
 *  only ever starts from a deliberately-cleared slate. Exported for tests. */
export function nextFightBuckets(
  prev: DpsBucket[],
  bucket: DpsBucket,
): DpsBucket[] {
  if (prev.length === 0) {
    return isCombatBucket(bucket) ? [bucket] : prev;
  }
  // Already frozen: stays exactly as-is regardless of what arrives.
  if (!isCombatBucket(prev[prev.length - 1])) return prev;
  // Still live (or this is the final empty bucket that freezes it): append.
  return [...prev, bucket].slice(-120);
}

// (audio cues use the shared cross-platform sound service — see lib/sound.ts)

// ---------------------------------------------------------------- MiniDpsChart

/** Mini DPS chart (out green, in red) over the fight's 5 s buckets. */
function MiniDpsChart({
  buckets,
  markTs,
}: {
  buckets: DpsBucket[];
  /** The combat-log footer's scroll position — shades the enclosing 5 s
   *  bucket, same arithmetic as the DPS meter's chart (#986). */
  markTs?: number | null;
}) {
  if (buckets.length < 2)
    return <div className="h-12 w-full rounded bg-zinc-950" />;
  const W = 100,
    H = 48,
    pad = 2;
  const w = W - pad * 2,
    h = H - pad * 2;
  const t0 = buckets[0].start;
  const span = Math.max(BUCKET_SECS, buckets[buckets.length - 1].end - t0);
  const maxVal = Math.max(
    1,
    ...buckets.flatMap((b) => [
      b.damageOut / BUCKET_SECS,
      b.damageIn / BUCKET_SECS,
    ]),
  );
  // x by bucket *time* (midpoint), not index — the grid has no holes, but
  // time-based placement keeps this honest if a frozen buffer is re-rendered.
  const x = (ts: number) => pad + ((ts - t0) / span) * w;
  const y = (v: number) => pad + h - (v / maxVal) * h;
  // Smooth each line (see `smoothSeries`) so a single volley's spike reads as
  // a trend; the axis still uses the raw peak so heights aren't understated.
  const smoothed = {
    damageOut: smoothSeries(buckets.map((b) => b.damageOut / BUCKET_SECS)),
    damageIn: smoothSeries(buckets.map((b) => b.damageIn / BUCKET_SECS)),
  };
  const path = (field: "damageOut" | "damageIn") =>
    buckets
      .map(
        (b, i) =>
          `${x(b.start + BUCKET_SECS / 2).toFixed(1)},${y(
            smoothed[field][i],
          ).toFixed(1)}`,
      )
      .join(" ");
  const markStart = markTs == null ? null : bucketStartOf(markTs);
  const markX =
    markStart == null || markStart < t0 || markStart >= t0 + span
      ? null
      : x(markStart);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded">
      <rect width={W} height={H} fill="#09090b" rx="3" />
      <polyline
        points={path("damageOut")}
        fill="none"
        stroke="#34d399"
        strokeWidth="1.5"
      />
      <polyline
        points={path("damageIn")}
        fill="none"
        stroke="#f87171"
        strokeWidth="1.5"
      />
      {markX != null && (
        <rect
          x={markX}
          y={pad}
          width={(BUCKET_SECS / span) * w}
          height={H - pad * 2}
          fill="#818cf8"
          fillOpacity="0.25"
          stroke="#818cf8"
          strokeWidth="0.5"
        />
      )}
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
  buckets,
  events,
  logCollapsed,
  onToggleLogCollapsed,
  logMarkTs,
  onLogVisiblePositionChange,
  attackers,
  myWeapons,
  localFits,
  selectedFitId,
  onSelectFit,
  fitWeaponRanges,
  myShip,
  autoFitName,
  droneReminder,
  onDismiss,
}: {
  buckets: DpsBucket[];
  events: DpsEvent[];
  logCollapsed: boolean;
  onToggleLogCollapsed: () => void;
  /** See `CombatLogPanel`'s `onVisiblePositionChange` — threaded through to
   *  mark the same position on `MiniDpsChart`. */
  logMarkTs: number | null;
  onLogVisiblePositionChange: (ts: number | null) => void;
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
  myShip: CharacterShip | null;
  /** When set, ranges are auto-derived from your current ship's matching fit
   *  (this is that fit's name); absent when a fit was picked manually. */
  autoFitName?: string;
  droneReminder: boolean;
  onDismiss: () => void;
}) {
  const latestBucket = buckets[buckets.length - 1];
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
    <Modal
      open
      onClose={onDismiss}
      role="alertdialog"
      aria-label="Active fight"
      backdrop={false}
      className="fixed left-1/2 top-1/2 z-50 flex h-[50vh] w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/95 shadow-2xl backdrop-blur"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 text-base font-semibold text-rose-400">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
            Active Fight
          </span>
          {latestBucket && (
            <span className="text-xs text-zinc-400">
              In{" "}
              <span className="tabular-nums text-rose-400">
                {Math.round(latestBucket.damageIn / BUCKET_SECS)}
              </span>{" "}
              · Out{" "}
              <span className="tabular-nums text-emerald-400">
                {Math.round(latestBucket.damageOut / BUCKET_SECS)}
              </span>{" "}
              dps
            </span>
          )}
          {myShip && (
            <span className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
              <span className="text-zinc-500">Ship</span>
              {myShip.typeName}
              {myShip.shipName && myShip.shipName !== myShip.typeName ? (
                <span className="text-zinc-500">· {myShip.shipName}</span>
              ) : null}
            </span>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          Dismiss ✕
        </button>
      </div>

      {/* Content: 3-column grid */}
      <div className="grid flex-1 grid-cols-3 divide-x divide-zinc-800 overflow-y-auto text-sm">
        {/* ── My Weapons ── */}
        <div className="flex flex-col gap-3 px-5 py-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            My weapons
          </h3>
          {droneReminder && (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-base font-semibold text-amber-300">
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              Launch drones
            </div>
          )}
          {/* What's firing now (from DPS log) */}
          {myWeapons.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {myWeapons.map((w, i) => (
                <div key={i} className="flex items-center gap-3 text-base">
                  <span className="flex-1 truncate text-zinc-200">
                    {w.name}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums text-emerald-400">
                    {Math.round(w.dps)} dps
                  </span>
                </div>
              ))}
            </div>
          )}
          {/* Ranges: auto from your current ship's matching fit (API), else a
              manual saved-fit picker as a fallback. ESI can't read your live
              fitted modules, so a matching saved fit is still needed. */}
          {autoFitName ? (
            <span className="rounded-md bg-zinc-800/60 px-3 py-2 text-sm text-zinc-400">
              Ranges from your ship’s fit ·{" "}
              <span className="text-zinc-100">{autoFitName}</span>
            </span>
          ) : (
            <>
              <span className="text-xs text-zinc-500">
                No fit from API — pick a saved fit for ranges
              </span>
              <select
                value={selectedFitId ?? ""}
                onChange={(e) => onSelectFit(e.currentTarget.value || null)}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-300"
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
            </>
          )}
          {uniqueRanges.length > 0 && (
            <div className="flex flex-col gap-1">
              {uniqueRanges.map((r, i) => (
                <div key={i} className="text-base tabular-nums text-zinc-300">
                  <span className="font-medium text-zinc-100">
                    {km(r.optimal)}
                  </span>
                  {r.falloff > 0 && (
                    <>
                      {" "}
                      →{" "}
                      <span className="font-medium text-zinc-100">
                        {km(r.optimal + r.falloff)}
                      </span>
                    </>
                  )}
                  <span className="ml-2 text-xs text-zinc-500">opt → max</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Attackers ── */}
        <div className="flex flex-col gap-2 px-5 py-4">
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
        <div className="flex flex-col gap-2 px-5 py-4">
          <h3 className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            DPS
          </h3>
          <MiniDpsChart buckets={buckets} markTs={logMarkTs} />
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

      {/* Combat log footer — collapsed by default so it doesn't crowd the
          3-column grid above; the same component the DPS meter page uses. */}
      <div className="shrink-0 border-t border-zinc-800 px-5 py-2">
        <CombatLogPanel
          events={events}
          collapsed={logCollapsed}
          onToggleCollapsed={onToggleLogCollapsed}
          onVisiblePositionChange={onLogVisiblePositionChange}
          maxHeightClass="max-h-32"
          className="border-none bg-transparent p-0"
        />
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------- test-fight data

/** A previewable sample fight for the Settings "Test" button — enough to
 *  exercise every part of the panel (attackers with ships/weapons, my weapons,
 *  ranges, known ship, drone reminder) without a live fight. */
interface TestFight {
  buckets: DpsBucket[];
  events: DpsEvent[];
  attackers: {
    name: string;
    dpsIn: number;
    ship?: string;
    weapons: string[];
  }[];
  myWeapons: { name: string; dps: number }[];
  fitWeaponRanges: WeaponRange[];
  myShip: CharacterShip;
  autoFitName: string;
  droneReminder: boolean;
}

function buildTestFight(): TestFight {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const hq = {
    misses: 1,
    glances: 2,
    grazes: 3,
    hits: 8,
    penetrates: 3,
    smashes: 1,
    wrecks: 0,
  };
  let out = rnd(90, 130);
  let inc = rnd(25, 55);
  // 30 finalized 5 s buckets (2.5 min of fight) on the epoch-aligned grid.
  const buckets: DpsBucket[] = Array.from({ length: 30 }, (_, i) => {
    out = Math.max(0, out + rnd(-15, 15));
    inc = Math.max(0, inc + rnd(-10, 10));
    const start = 1_700_000_000 + i * BUCKET_SECS;
    return {
      start,
      end: start + BUCKET_SECS,
      damageOut: out * BUCKET_SECS,
      damageIn: inc * BUCKET_SECS,
      repOut: 0,
      repIn: 0,
      capTransferOut: 0,
      capTransferIn: 0,
      capWarfareOut: 0,
      capWarfareIn: 0,
      miningM3: 0,
      hitsOut: hq,
      hitsIn: hq,
      byWeapon: [
        { name: "Caldari Navy Inferno Rocket", dps: out, kind: "Rocket" },
      ],
      byPilot: [],
    };
  });
  // Sample combat log — one outgoing hit per bucket, an incoming hit every
  // third (two attackers alternating), plus one scram/point pair, so the
  // Test preview exercises every line kind the real log renders.
  const qualities = ["Hits", "Grazes", "Penetrates", "Wrecks", "Smashes"];
  const events: DpsEvent[] = buckets.flatMap((b, i) => {
    const dealt: DpsEvent = {
      ts: b.start,
      kind: "damageOut",
      amount: Math.max(1, Math.round(b.damageOut / BUCKET_SECS / 2)),
      pilot: i % 2 === 0 ? "John Doe" : "Jane Doe",
      ship: i % 2 === 0 ? "Kestrel" : "Incursus",
      weapon: "Caldari Navy Inferno Rocket",
      quality: qualities[i % qualities.length],
      ore: null,
      volume: 0,
    };
    if (i % 3 !== 0) return [dealt];
    const taken: DpsEvent = {
      ts: b.start,
      kind: "damageIn",
      amount: Math.max(1, Math.round(b.damageIn / BUCKET_SECS / 2)),
      pilot: i % 2 === 0 ? "John Doe" : "Jane Doe",
      ship: i % 2 === 0 ? "Kestrel" : "Incursus",
      weapon: i % 2 === 0 ? "Inferno Rage Rocket" : "Light Ion Blaster II",
      quality: qualities[(i + 2) % qualities.length],
      ore: null,
      volume: 0,
    };
    return [dealt, taken];
  });
  events.push(
    {
      ts: 1_700_000_010,
      kind: "scramIn",
      amount: 0,
      pilot: "Jane Doe",
      ship: "Incursus",
      weapon: null,
      quality: null,
      ore: null,
      volume: 0,
    },
    {
      ts: 1_700_000_018,
      kind: "pointOut",
      amount: 0,
      pilot: "John Doe",
      ship: "Kestrel",
      weapon: null,
      quality: null,
      ore: null,
      volume: 0,
    },
  );
  return {
    buckets,
    events,
    attackers: [
      {
        name: "John Doe",
        dpsIn: Math.round(inc),
        ship: "Kestrel",
        weapons: ["Inferno Rage Rocket", "Scourge Rocket"],
      },
      {
        name: "Jane Doe",
        dpsIn: Math.round(rnd(10, 30)),
        ship: "Incursus",
        weapons: ["Light Ion Blaster II"],
      },
    ],
    myWeapons: [{ name: "Caldari Navy Inferno Rocket", dps: Math.round(out) }],
    fitWeaponRanges: [
      { typeId: 1, optimal: 12_000, falloff: 8_000 } as WeaponRange,
    ],
    myShip: { typeId: 602, typeName: "Kestrel", shipName: "Test Kestrel" },
    autoFitName: "Rocket Kestrel",
    droneReminder: true,
  };
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
  const [fightBuckets, setFightBuckets] = useState<DpsBucket[]>([]);
  const [fightLogEvents, setFightLogEvents] = useState<DpsEvent[]>([]);
  const [logCollapsed, setLogCollapsed] = usePersistentState<boolean>(
    STORAGE_KEYS.fightOverlayCombatLogCollapsed,
    true,
  );
  // Where the combat log footer is scrolled to — marked on MiniDpsChart.
  const [fightLogMarkTs, setFightLogMarkTs] = useState<number | null>(null);
  const [fightOpen, setFightOpen] = useState(false);
  const [selectedFitId, setSelectedFitId] = useState<string | null>(null);
  // Settings "Test" preview: sample data, rebuilt each time the button is hit.
  const [testFight, setTestFight] = useState<TestFight | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);
  const unlistenEventsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!enabled) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setFightBuckets([]);
      return;
    }
    let cancelled = false;
    onDpsBuckets((batch) => {
      if (!cancelled) {
        setFightBuckets((prev) => batch.reduce(nextFightBuckets, prev));
      }
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

  // Combat-log view alongside the bucket chart — the same batched events,
  // kept for as long as `fightBuckets` is (cleared on the same two resets:
  // disabling the overlay and Dismiss). Not gated by the freeze logic: once
  // a fight freezes, any further activity is rare and still truthful to show.
  useEffect(() => {
    if (!enabled) {
      unlistenEventsRef.current?.();
      unlistenEventsRef.current = null;
      setFightLogEvents([]);
      return;
    }
    let cancelled = false;
    onDpsEvents((batch) => {
      if (!cancelled) setFightLogEvents((prev) => appendEvents(prev, batch));
    }).then((fn) => {
      if (cancelled) fn();
      else unlistenEventsRef.current = fn;
    });
    return () => {
      cancelled = true;
      unlistenEventsRef.current?.();
      unlistenEventsRef.current = null;
    };
  }, [enabled]);

  // Auto-run a background live capture whenever the overlay is on, so combat
  // is always detected without opening the DPS meter first. `dps_start` seeks
  // to the current end of the newest gamelog and is generation-guarded, so
  // this simply (re)claims the shared tail; the DPS page still starts/stops
  // its own. We (re)start once per enable and when the folder changes.
  const [gamelogsDir] = useEveLogDir("gamelogs");
  const startedDirRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      startedDirRef.current = null;
      return;
    }
    if (!gamelogsDir || startedDirRef.current === gamelogsDir) return;
    startedDirRef.current = gamelogsDir;
    void dpsStart({ gamelogsDir }).catch(() => {});
  }, [enabled, gamelogsDir]);

  const latestBucket = fightBuckets[fightBuckets.length - 1];
  const latestAt = latestBucket?.end ?? 0;

  // Active attackers: player pilots dealing incoming damage in the last 15 s
  // (three buckets). NPCs are filtered by requiring `ship` — EVE always emits
  // `(SHIP)` for player characters in gamelogs; NPCs omit it.
  const activeAttackers = useMemo(() => {
    const seen = new Map<
      string,
      { dpsIn: number; lastAt: number; ship?: string; weapons: string[] }
    >();
    for (const bucket of fightBuckets) {
      for (const p of bucket.byPilot) {
        if (p.dpsIn > 0) {
          const ex = seen.get(p.name);
          seen.set(p.name, {
            dpsIn: p.dpsIn,
            lastAt: Math.max(bucket.end, ex?.lastAt ?? 0),
            // Live log data: ship is authoritative; accumulate unique weapons.
            ship: p.ship ?? ex?.ship,
            weapons: ex
              ? [
                  ...ex.weapons,
                  ...(p.weaponsIn ?? [])
                    .map((w) => w.name)
                    .filter((n) => !ex.weapons.includes(n)),
                ]
              : (p.weaponsIn ?? []).map((w) => w.name),
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
  }, [fightBuckets, latestAt]);

  // Sticky open latch: a detected fight opens the overlay and it STAYS open
  // until you dismiss it (or disable the feature). It no longer auto-hides
  // when incoming damage stops, so a short fight doesn't flash and vanish.
  useEffect(() => {
    if (!enabled) {
      setFightOpen(false);
      return;
    }
    if (activeAttackers.length > 0) setFightOpen(true);
  }, [enabled, activeAttackers.length]);

  const fightActive = enabled && fightOpen;

  // Fit data for "my ranges" in the fight panel.
  const localFits = useQuery({
    queryKey: ["fitting", "local"],
    queryFn: fittingListLocal,
    staleTime: 30_000,
    enabled,
  });

  // My current ship via ESI (needs the read_ship_type scope). Only when known
  // do we auto-load optimals + drone reminders. Polls so swapping ships mid-
  // session is picked up; `null` when logged out or the scope isn't granted.
  const myShip = useQuery<CharacterShip | null>({
    queryKey: ["esi", "character-ship"],
    queryFn: characterShip,
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? FIGHT_OVERLAY_SHIP_POLL_INTERVAL_MS : false,
  });
  const ship = myShip.data ?? null;

  // Auto-pick a saved fit for the current hull (only when the ship is known).
  // A manual selection always overrides it.
  const autoFit =
    ship != null
      ? (localFits.data?.find((f) => f.shipTypeId === ship.typeId) ?? null)
      : null;
  const effectiveFitId = selectedFitId ?? autoFit?.id ?? null;
  const effectiveFit =
    localFits.data?.find((f) => f.id === effectiveFitId) ?? null;
  const fitStats = useQuery({
    queryKey: ["pvp", "fight-fit-stats", effectiveFitId],
    queryFn: () => fittingSimulate(effectiveFit!),
    enabled: effectiveFit != null,
    staleTime: Infinity,
  });

  // Drone reminder: only when we know your ship (via API) and its fit carries
  // drones, but no drone damage is landing in the current window.
  const dronesFiring = (latestBucket?.byWeapon ?? []).some((w) =>
    (w.kind ?? "").includes("Drone"),
  );
  const fitHasDrones =
    effectiveFit?.items.some((i) => i.slot === "drone" && i.quantity > 0) ??
    false;
  const droneReminder = ship != null && fitHasDrones && !dronesFiring;

  // Audio cues on state transitions (only while a real fight is live). Scram
  // and point come from the combat log; webs are never logged so there's no
  // web cue. Fires on the edge so it announces once per change, not per tick.
  const scrammed = (latestBucket?.byPilot ?? []).some((p) => p.scramIn);
  const pointed = (latestBucket?.byPilot ?? []).some((p) => p.pointIn);
  const cuesRef = useRef({ scram: false, point: false, drones: false });
  useEffect(() => {
    if (!enabled || !fightActive) {
      cuesRef.current = { scram: false, point: false, drones: false };
      return;
    }
    const prev = cuesRef.current;
    if (scrammed && !prev.scram) playCue("scram");
    else if (!scrammed && prev.scram) playCue("scramOff");
    if (pointed && !prev.point) playCue("point");
    else if (!pointed && prev.point) playCue("pointOff");
    if (droneReminder && !prev.drones) playCue("drones");
    cuesRef.current = {
      scram: scrammed,
      point: pointed,
      drones: droneReminder,
    };
  }, [enabled, fightActive, scrammed, pointed, droneReminder]);

  // The Test button shows the sample panel AND plays the cue clips so you can
  // hear them (fired from the click gesture, which autoplay policies want).
  // Staggered so the clips don't overlap.
  function runTest() {
    setTestFight(buildTestFight());
    const demo: CueSound[] = ["scram", "point", "drones"];
    demo.forEach((name, i) => setTimeout(() => playCue(name), i * 1500));
  }

  return (
    <FightOverlayContext.Provider value={{ enabled, setEnabled, runTest }}>
      {children}
      {/* Test preview takes precedence over a live fight so the button always
          shows the sample; both are the same fixed panel. */}
      {testFight ? (
        <FightPanel
          buckets={testFight.buckets}
          events={testFight.events}
          logCollapsed={logCollapsed}
          onToggleLogCollapsed={() => setLogCollapsed(!logCollapsed)}
          logMarkTs={fightLogMarkTs}
          onLogVisiblePositionChange={setFightLogMarkTs}
          attackers={testFight.attackers}
          myWeapons={testFight.myWeapons}
          localFits={localFits.data ?? []}
          selectedFitId={null}
          onSelectFit={() => {}}
          fitWeaponRanges={testFight.fitWeaponRanges}
          myShip={testFight.myShip}
          autoFitName={testFight.autoFitName}
          droneReminder={testFight.droneReminder}
          onDismiss={() => setTestFight(null)}
        />
      ) : (
        fightActive && (
          <FightPanel
            buckets={fightBuckets}
            events={fightLogEvents}
            logCollapsed={logCollapsed}
            onToggleLogCollapsed={() => setLogCollapsed(!logCollapsed)}
            logMarkTs={fightLogMarkTs}
            onLogVisiblePositionChange={setFightLogMarkTs}
            attackers={activeAttackers}
            myWeapons={latestBucket?.byWeapon ?? []}
            localFits={localFits.data ?? []}
            selectedFitId={selectedFitId}
            onSelectFit={setSelectedFitId}
            fitWeaponRanges={fitStats.data?.weaponRanges ?? []}
            myShip={ship}
            autoFitName={
              autoFit && selectedFitId == null ? autoFit.name : undefined
            }
            droneReminder={droneReminder}
            onDismiss={() => {
              setFightOpen(false);
              setFightBuckets([]);
              setFightLogEvents([]);
              setFightLogMarkTs(null);
            }}
          />
        )
      )}
    </FightOverlayContext.Provider>
  );
}
