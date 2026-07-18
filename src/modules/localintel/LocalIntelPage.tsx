import {
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  errorMessage,
  localLogNames,
  localScan,
  localintelGetWatchlist,
  localintelSetWatchlist,
  localintelZkill,
  routeLocation,
  systemNeighbourhood,
  type LocalPilot,
  type LocalScanResult,
  type NeighbourNode,
  type ZkillStats,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { SEC_TEXT_CLASS, secBand } from "../../lib/security";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { usePersistentState } from "../../lib/usePersistentState";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { classifyArrivals } from "./classifyArrivals";

/** Best-effort desktop notification — requests permission, never throws. */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable — the in-app highlight still shows */
  }
}

/** Short two-tone alarm beep via Web Audio (no asset). Best-effort. */
function playAlarm() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const beep = (start: number, freq: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(
        0.25,
        ctx.currentTime + start + 0.02,
      );
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        ctx.currentTime + start + 0.18,
      );
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + 0.2);
    };
    beep(0, 880);
    beep(0.22, 1175);
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch {
    /* audio unavailable */
  }
}

export function LocalIntelPage() {
  const qc = useQueryClient();
  // ModuleHost (Layout) keeps every visited page mounted (hidden with
  // `display:none`), so without this gate the two 30s polls below would keep
  // hitting ESI for the rest of the session once the page has been visited,
  // burning the ESI error budget for an invisible panel. Mirrors DpsPage.
  const active = useContext(ModuleActiveContext);
  const [text, setText] = useState("");
  const [alertAnyRed, setAlertAnyRed] = useState(true);
  const [alertNeutrals, setAlertNeutrals] = useState(
    () => localStorage.getItem(STORAGE_KEYS.localintelAlertNeutrals) === "on",
  );
  const [soundOn, setSoundOn] = useState(
    () => localStorage.getItem(STORAGE_KEYS.localintelSound) !== "off",
  );
  // Pilot ids from the previous scan, so we can alert only when a *new* threat
  // enters Local (re-pasting the same list doesn't re-alarm), and flag arrivals.
  const prevIdsRef = useRef<Set<number>>(new Set());
  const [newIds, setNewIds] = useState<Set<number>>(new Set());
  // EVE logs folder (Chatlogs); persisted. Used to prefill names from the
  // newest Local log — only pilots who chatted (logs lack the member list).
  const [logsDir, setLogsDir, persistLogsDir] = useEveLogDir("chatlogs");
  const loadLog = useMutation({
    mutationFn: () => localLogNames(logsDir),
    onSuccess: (r) => {
      persistLogsDir();
      if (r.senders.length > 0) setText(r.senders.join("\n"));
    },
  });

  const watchlist = useQuery({
    queryKey: ["localintel", "watchlist"],
    queryFn: localintelGetWatchlist,
  });
  const watchIds = useMemo(
    () => new Set((watchlist.data ?? []).map((w) => w.id)),
    [watchlist.data],
  );

  const [zkill, setZkill] = useState<Map<number, ZkillStats>>(new Map());

  const zkillRun = useMutation({
    mutationFn: (ids: number[]) => localintelZkill(ids),
    onSuccess: (stats) =>
      setZkill(new Map(stats.map((s) => [s.characterId, s]))),
  });

  const scan = useMutation({
    mutationFn: (t: string) => localScan(t),
    onSuccess: (res) => {
      setZkill(new Map());
      const ids = res.pilots.map((p) => p.characterId);
      if (ids.length > 0) zkillRun.mutate(ids);

      const {
        newIds: fresh,
        notice,
        alarm,
      } = classifyArrivals(prevIdsRef.current, res.pilots, watchIds, {
        alertAnyRed,
        alertNeutrals,
      });
      setNewIds(fresh);

      if (notice) {
        const names = notice.pilots
          .slice(0, 5)
          .map((p) => p.name)
          .join(", ");
        if (notice.kind === "watchlist") {
          notify(
            "⚠️ Watchlisted pilots entered local",
            `${notice.pilots.length}: ${names}`,
          );
        } else if (notice.kind === "red") {
          notify(
            "⚠️ Reds entered local",
            `${notice.pilots.length} hostile pilot(s)`,
          );
        } else {
          notify(
            "⚠️ Neutrals entered local",
            `${notice.pilots.length} unknown pilot(s)`,
          );
        }
      }
      if (alarm && soundOn) playAlarm();

      prevIdsRef.current = new Set(ids);
    },
  });

  const setWatch = useMutation({
    mutationFn: (v: { id: number; name: string; add: boolean }) =>
      localintelSetWatchlist(v.id, v.name, v.add),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["localintel", "watchlist"] }),
  });

  const result = scan.data;
  // Stable references so the memoized PilotTable/HostileCorpsPanel only
  // re-render when their actual inputs change — not on every keystroke in the
  // paste textarea or every 30s poll tick (see the memo() notes below).
  const isWatched = useCallback(
    (p: LocalPilot) =>
      watchIds.has(p.corporationId) ||
      (p.allianceId != null && watchIds.has(p.allianceId)),
    [watchIds],
  );
  const watchMutate = setWatch.mutate; // mutate is referentially stable
  const onWatch = useCallback(
    (id: number, name: string) => watchMutate({ id, name, add: true }),
    [watchMutate],
  );

  // Right-rail danger list: player corporations in local you've set a negative
  // (red) standing toward. Player corp ids start at 98,000,000 (NPC corps are
  // far lower), so this skips the empire NPC corps everyone in highsec belongs
  // to. Pilots with no standing set (neutrals/unknowns) aren't flagged here.
  const hostileCorps = useMemo(() => {
    const map = new Map<
      number,
      { id: number; name: string; standing: number; count: number }
    >();
    for (const p of result?.pilots ?? []) {
      if (
        p.corporationId >= 98_000_000 &&
        p.standing != null &&
        p.standing < HOSTILE_STANDING
      ) {
        const ex = map.get(p.corporationId);
        if (ex) {
          ex.count += 1;
          ex.standing = Math.min(ex.standing, p.standing);
        } else {
          map.set(p.corporationId, {
            id: p.corporationId,
            name: p.corporation || `Corp ${p.corporationId}`,
            standing: p.standing,
            count: 1,
          });
        }
      }
    }
    return [...map.values()].sort(
      (a, b) => a.standing - b.standing || b.count - a.count,
    );
  }, [result]);

  // Neighbourhood intel: recent kills/jumps in systems around the active
  // character's current location (CCP hourly aggregates, k-space only).
  const [hoodDepth, setHoodDepth] = usePersistentState(
    "localintel.hoodDepth",
    2,
  );
  const location = useQuery({
    queryKey: ["localintel", "location"],
    queryFn: routeLocation,
    // Only while the page is on screen: a stale location then refreshes
    // immediately on return (staleTime) instead of waiting a full interval.
    enabled: active,
    // Auto-refresh so the panel follows the character as they move.
    refetchInterval: active ? 30_000 : false,
  });
  const here = location.data?.[location.data.length - 1];
  const hood = useQuery({
    queryKey: ["localintel", "hood", here?.systemId ?? null, hoodDepth],
    queryFn: () => systemNeighbourhood(here!.systemId, hoodDepth),
    enabled: here != null,
    // Keep neighbourhood kills/jumps live (CCP aggregates update ~hourly) —
    // but only while the page is visible.
    refetchInterval: active ? 30_000 : false,
  });

  return (
    <div className="flex h-full">
      <div className="min-w-0 flex-1 overflow-auto">
        <Page>
          <PageHeader
            title="Local Intel"
            subtitle="Select-all in the in-game Local member list, copy, and paste it here to classify every pilot by corp/alliance against your character's contacts (blue/red) and standings."
            actions={
              <PrimaryButton
                onClick={() => scan.mutate(text)}
                disabled={scan.isPending || text.trim() === ""}
                pending={scan.isPending}
                pendingLabel="Scanning…"
              >
                Scan local
              </PrimaryButton>
            }
          />

          <textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder="Paste the Local member list (one pilot name per line)…"
            rows={5}
            className="mt-4 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <input
              value={logsDir}
              onChange={(e) => setLogsDir(e.currentTarget.value)}
              placeholder="EVE Chatlogs folder…"
              className="w-72 rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-600"
              title="e.g. …/ProtonPrefix/drive_c/users/steamuser/Documents/EVE/logs/Chatlogs"
            />
            <button
              onClick={() => loadLog.mutate()}
              disabled={logsDir.trim() === "" || loadLog.isPending}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Load from latest Local log
            </button>
            {loadLog.isError && (
              <span className="text-rose-400">
                {errorMessage(loadLog.error)}
              </span>
            )}
            {loadLog.data && (
              <span className="text-zinc-500">
                {loadLog.data.senders.length > 0
                  ? `${loadLog.data.senders.length} speaker(s) from ${loadLog.data.file}`
                  : "no chat found (only pilots who spoke are logged)"}
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
            <label
              className="flex cursor-pointer items-center gap-2"
              title="Alarm when a red enters Local"
            >
              <input
                type="checkbox"
                checked={alertAnyRed}
                onChange={(e) => setAlertAnyRed(e.currentTarget.checked)}
              />
              Alert on any red
            </label>
            <label
              className="flex cursor-pointer items-center gap-2"
              title="Also alarm when any neutral/unknown pilot enters Local"
            >
              <input
                type="checkbox"
                checked={alertNeutrals}
                onChange={(e) => {
                  setAlertNeutrals(e.currentTarget.checked);
                  localStorage.setItem(
                    STORAGE_KEYS.localintelAlertNeutrals,
                    e.currentTarget.checked ? "on" : "off",
                  );
                }}
              />
              Alert on neutrals
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={soundOn}
                onChange={(e) => {
                  setSoundOn(e.currentTarget.checked);
                  localStorage.setItem(
                    STORAGE_KEYS.localintelSound,
                    e.currentTarget.checked ? "on" : "off",
                  );
                  if (e.currentTarget.checked) playAlarm(); // confirm it's audible
                }}
              />
              Sound alarm
            </label>
            {(watchlist.data ?? []).length > 0 && (
              <span>
                Watching:{" "}
                {(watchlist.data ?? []).map((w) => (
                  <button
                    key={w.id}
                    onClick={() =>
                      setWatch.mutate({ id: w.id, name: w.name, add: false })
                    }
                    title="Remove from watchlist"
                    className="mr-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-amber-300 hover:bg-amber-900/70"
                  >
                    {w.name} ✕
                  </button>
                ))}
              </span>
            )}
          </div>

          {scan.isError && (
            <div className="mt-3 text-sm text-rose-400">
              Failed: {errorMessage(scan.error)}
            </div>
          )}

          {result && <Summary result={result} />}
          {result && (
            <PilotTable
              pilots={result.pilots}
              zkill={zkill}
              zkillLoading={zkillRun.isPending}
              isWatched={isWatched}
              newIds={newIds}
              onWatch={onWatch}
            />
          )}
          {result && result.unresolved.length > 0 && (
            <div className="mt-2 text-xs text-zinc-500">
              Unresolved ({result.unresolved.length}):{" "}
              {result.unresolved.join(", ")}
            </div>
          )}
        </Page>
      </div>
      <aside className="flex w-64 shrink-0 flex-col overflow-auto border-l border-zinc-800 bg-zinc-900/40">
        <HostileCorpsPanel
          corps={hostileCorps}
          scanned={!!result}
          watchIds={watchIds}
          onWatch={onWatch}
        />
        <NeighbourhoodPanel
          here={here}
          nodes={hood.data?.nodes}
          depth={hoodDepth}
          onDepth={setHoodDepth}
          loading={location.isFetching || hood.isFetching}
          locError={location.isError}
          onRefresh={() => {
            void location.refetch();
            void hood.refetch();
          }}
        />
      </aside>
    </div>
  );
}

/** Hostile player-corp threshold: any negative standing — matches the "red"
 *  classification the pilot list uses (standing < 0), rather than the old, much
 *  stricter < −4 that hid most reds. */
const HOSTILE_STANDING = 0;

/** Right-rail panel: player corporations in local with a negative (red) standing.
 *  Memoized: the parent re-renders on every textarea keystroke and poll tick;
 *  this panel's props (memoized corps list, stable onWatch) don't change then. */
const HostileCorpsPanel = memo(function HostileCorpsPanel({
  corps,
  scanned,
  watchIds,
  onWatch,
}: {
  corps: { id: number; name: string; standing: number; count: number }[];
  scanned: boolean;
  watchIds: Set<number>;
  onWatch: (id: number, name: string) => void;
}) {
  return (
    <div className="border-b border-zinc-800 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-rose-400">
        Hostile corps
      </div>
      <div className="mb-2 text-[11px] text-zinc-500">
        player corps · red (standing &lt; 0)
      </div>
      {corps.length === 0 ? (
        <div className="text-xs text-zinc-600">
          {scanned ? "None in local." : "Scan to populate."}
        </div>
      ) : (
        <ul className="space-y-1">
          {corps.map((c) => (
            <li
              key={c.id}
              className="rounded border border-rose-900/40 bg-rose-950/20 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-sm text-zinc-200" title={c.name}>
                  {c.name}
                </span>
                <span className="shrink-0 tabular-nums text-xs text-rose-400">
                  {c.standing.toFixed(1)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between text-[11px] text-zinc-500">
                <span>
                  {c.count} pilot{c.count === 1 ? "" : "s"} in local
                </span>
                {watchIds.has(c.id) ? (
                  <span className="text-amber-400">watched</span>
                ) : (
                  <button
                    onClick={() => onWatch(c.id, c.name)}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                  >
                    +watch
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * Right-rail panel: recent ship/pod kills (CCP hourly, k-space) in systems
 * within N jumps of the active character's current location — "what's happening
 * around me" while watching Local. Empty in wormholes (no stargate graph / no
 * k-space kill data).
 */
function NeighbourhoodPanel({
  here,
  nodes,
  depth,
  onDepth,
  loading,
  locError,
  onRefresh,
}: {
  here?: { systemId: number; name: string; security: number };
  nodes?: NeighbourNode[];
  depth: number;
  onDepth: (d: number) => void;
  loading: boolean;
  locError: boolean;
  onRefresh: () => void;
}) {
  const nearby = useMemo(
    () =>
      [...(nodes ?? [])]
        .filter((n) => n.distance > 0)
        .sort(
          (a, b) =>
            b.shipKills + b.podKills - (a.shipKills + a.podKills) ||
            a.distance - b.distance ||
            a.name.localeCompare(b.name),
        )
        .slice(0, 15),
    [nodes],
  );

  return (
    <div className="p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
          Neighbourhood
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          title="Refresh location + nearby activity"
          className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "…" : "↻"}
        </button>
      </div>
      <div className="mb-2 flex items-center gap-1 text-[11px] text-zinc-500">
        kills/hr · ≤
        {[1, 2, 3].map((d) => (
          <button
            key={d}
            onClick={() => onDepth(d)}
            className={`rounded px-1 ${
              depth === d
                ? "bg-zinc-700 text-zinc-100"
                : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {d}
          </button>
        ))}
        jumps
      </div>

      {locError || !here ? (
        <div className="text-xs text-zinc-600">
          Needs your in-game location (the{" "}
          <code>esi-location.read_location.v1</code> scope) — set an active
          character and re-login if just enabled.
        </div>
      ) : (
        <>
          <div className="mb-1 text-xs text-zinc-400">
            You:{" "}
            <a
              href={`https://zkillboard.com/system/${here.systemId}/`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-zinc-200 hover:text-indigo-300"
              title="Recent kills in this system on zKillboard"
            >
              {here.name}
              <ExternalLink size={10} className="opacity-60" />
            </a>{" "}
            <span
              className={`tabular-nums ${SEC_TEXT_CLASS[secBand(here.security)]}`}
            >
              {here.security.toFixed(1)}
            </span>
          </div>
          {nearby.length === 0 ? (
            <div className="text-xs text-zinc-600">
              {loading ? "Loading…" : "Quiet — no kills nearby this hour."}
            </div>
          ) : (
            <ul className="space-y-0.5">
              {nearby.map((n) => (
                <li
                  key={n.systemId}
                  className="flex items-center justify-between gap-1 text-xs"
                >
                  <span
                    className="min-w-0 truncate text-zinc-300"
                    title={`${n.name} · ${n.region}`}
                  >
                    <span className={SEC_TEXT_CLASS[secBand(n.security)]}>
                      •
                    </span>{" "}
                    <a
                      href={`https://zkillboard.com/system/${n.systemId}/`}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-indigo-300"
                    >
                      {n.name}
                    </a>{" "}
                    <span className="text-zinc-600">{n.distance}j</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {n.podKills > 0 && (
                      <span className="text-rose-400" title="pod kills">
                        💀{n.podKills}{" "}
                      </span>
                    )}
                    {n.shipKills > 0 && (
                      <span className="text-amber-400" title="ship kills">
                        ⚔{n.shipKills}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ result }: { result: LocalScanResult }) {
  return (
    <div className="mt-4 flex items-center gap-4 text-sm">
      <span className="text-zinc-300">
        {formatInt(result.pilots.length)} pilots
      </span>
      <span className="text-rose-400">{formatInt(result.reds)} red</span>
      <span className="text-zinc-400">
        {formatInt(result.neutrals)} neutral
      </span>
      <span className="text-sky-400">{formatInt(result.blues)} blue</span>
    </div>
  );
}

/** Memoized: a busy Local paste is 500-2,000 rows x 6 cells; without memo()
 *  every keystroke in the paste textarea and every 30s poll tick re-diffed the
 *  whole table even though its data hadn't changed. Props are kept stable in
 *  the parent (state Maps/Sets, useCallback'd isWatched/onWatch). */
const PilotTable = memo(function PilotTable({
  pilots,
  zkill,
  zkillLoading,
  isWatched,
  newIds,
  onWatch,
}: {
  pilots: LocalPilot[];
  zkill: Map<number, ZkillStats>;
  zkillLoading: boolean;
  isWatched: (p: LocalPilot) => boolean;
  newIds: Set<number>;
  onWatch: (id: number, name: string) => void;
}) {
  return (
    <div className="mt-3 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Pilot</th>
            <th className="px-3 py-1.5 text-left font-medium">Corporation</th>
            <th className="px-3 py-1.5 text-left font-medium">Alliance</th>
            <th className="px-3 py-1.5 text-right font-medium">Standing</th>
            <th className="px-3 py-1.5 text-right font-medium">
              Danger{zkillLoading ? " …" : ""}
            </th>
            <th className="px-3 py-1.5 text-right font-medium">Watch</th>
          </tr>
        </thead>
        <tbody>
          {pilots.map((p) => {
            const z = zkill.get(p.characterId);
            return (
              <tr
                key={p.characterId}
                className={`border-t border-zinc-800 hover:bg-zinc-800/40 ${
                  isWatched(p) ? "bg-amber-950/30" : ""
                }`}
              >
                <td className="px-3 py-1.5">
                  <span className={dot(p.threat)}>●</span>{" "}
                  <a
                    href={`https://zkillboard.com/character/${p.characterId}/`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zinc-200 hover:text-indigo-300"
                  >
                    {p.name}
                  </a>
                  {newIds.has(p.characterId) && (
                    <span
                      className="ml-2 rounded bg-amber-500/20 px-1 text-[10px] font-medium text-amber-300"
                      title="Entered Local since your last scan"
                    >
                      NEW
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-zinc-400">
                  {p.corporation || "—"}
                </td>
                <td className="px-3 py-1.5 text-zinc-400">
                  {p.alliance ?? "—"}
                </td>
                <td
                  className={`px-3 py-1.5 text-right tabular-nums ${standingColor(p.threat)}`}
                >
                  {p.standing == null ? "—" : p.standing.toFixed(1)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {z ? (
                    <span
                      className={dangerColor(z.dangerRatio)}
                      title={`${z.shipsDestroyed} kills / ${z.shipsLost} losses${z.active ? " · recently active" : ""}`}
                    >
                      {z.dangerRatio}%{z.active ? " ⚡" : ""}
                    </span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-xs">
                  {p.allianceId != null && (
                    <button
                      onClick={() =>
                        onWatch(
                          p.allianceId!,
                          p.alliance ?? `Alliance ${p.allianceId}`,
                        )
                      }
                      className="mr-1 rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                      title="Watch this alliance"
                    >
                      +alliance
                    </button>
                  )}
                  {p.corporationId !== 0 && (
                    <button
                      onClick={() =>
                        onWatch(
                          p.corporationId,
                          p.corporation || `Corp ${p.corporationId}`,
                        )
                      }
                      className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
                      title="Watch this corporation"
                    >
                      +corp
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {pilots.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                No pilots resolved.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});

function dot(threat: string): string {
  if (threat === "red") return "text-rose-500";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-500";
}
function standingColor(threat: string): string {
  if (threat === "red") return "text-rose-400";
  if (threat === "blue") return "text-sky-400";
  return "text-zinc-400";
}
/** zKill danger ratio → color: high = dangerous (red), low = soft target. */
function dangerColor(danger: number): string {
  if (danger >= 75) return "text-rose-400";
  if (danger >= 40) return "text-amber-400";
  return "text-zinc-400";
}
