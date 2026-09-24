import {
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  localLogNames,
  localScan,
  localintelGetWatchlist,
  localintelSetWatchlist,
  localintelZkill,
  routeLocation,
  systemNeighbourhood,
  type LocalPilot,
  type ZkillStats,
} from "../../lib/api";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { usePersistentState } from "../../lib/usePersistentState";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import { classifyArrivals } from "./classifyArrivals";

/** Hostile player-corp threshold: any negative standing — matches the "red"
 *  classification the pilot list uses (standing < 0), rather than the old, much
 *  stricter < −4 that hid most reds. */
const HOSTILE_STANDING = 0;

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

/** Short two-tone alarm beep via Web Audio (no asset). Returns whether it
 *  actually played — this beep is the hostile-alert safety channel (#819),
 *  so a failure (autoplay policy, no audio device, unsupported API, …) must
 *  surface to the caller instead of vanishing into a silent catch. */
function playAlarm(): boolean {
  try {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) throw new Error("Web Audio unavailable");
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
    setTimeout(() => {
      ctx
        .close()
        .catch((e) => console.error("Failed to close audio context", e));
    }, 600);
    return true;
  } catch (e) {
    console.error("Hostile-alert audio failed to play", e);
    return false;
  }
}

/** Alarm-related settings/flags, grouped into one reducer instead of five
 *  separate `useState`s — see #841. */
interface AlarmSettings {
  alertAnyRed: boolean;
  alertNeutrals: boolean;
  soundOn: boolean;
  /** Persistent warning once the alarm beep has failed to play (autoplay
   *  policy, no audio device, …) — this is a safety alert, so a silent
   *  failure must degrade loudly instead of pretending coverage exists
   *  (#819). Cleared the next time the alarm actually plays. */
  audioUnavailable: boolean;
  /** Brief full-page flash as a visual fallback for the same failure. */
  flashAlert: boolean;
}

type AlarmAction =
  | { type: "setAlertAnyRed"; value: boolean }
  | { type: "setAlertNeutrals"; value: boolean }
  | { type: "setSoundOn"; value: boolean }
  | { type: "setAudioUnavailable"; value: boolean }
  | { type: "setFlashAlert"; value: boolean };

function alarmSettingsReducer(
  state: AlarmSettings,
  action: AlarmAction,
): AlarmSettings {
  switch (action.type) {
    case "setAlertAnyRed":
      return { ...state, alertAnyRed: action.value };
    case "setAlertNeutrals":
      return { ...state, alertNeutrals: action.value };
    case "setSoundOn":
      return { ...state, soundOn: action.value };
    case "setAudioUnavailable":
      return { ...state, audioUnavailable: action.value };
    case "setFlashAlert":
      return { ...state, flashAlert: action.value };
  }
}

function initAlarmSettings(): AlarmSettings {
  return {
    alertAnyRed: true,
    alertNeutrals:
      localStorage.getItem(STORAGE_KEYS.localintelAlertNeutrals) === "on",
    soundOn: localStorage.getItem(STORAGE_KEYS.localintelSound) !== "off",
    audioUnavailable: false,
    flashAlert: false,
  };
}

/**
 * The Local Intel data layer: scan/zkill/log-import mutations, the
 * watchlist/location/neighbourhood queries, and the hostile-arrival
 * alarm/notification trigger. Owns nothing about rendering — importable and
 * callable on its own (e.g. from a test) independent of the page markup.
 *
 * Alarm behavior (sound + flash + notification on a hostile scan match) is
 * moved verbatim from the original `LocalIntelPage` — this is the
 * safety-critical path for players in-game (#819) and must stay
 * byte-identical.
 */
export function useLocalIntelData() {
  const qc = useQueryClient();
  // ModuleHost (Layout) keeps every visited page mounted (hidden with
  // `display:none`), so without this gate the two 30s polls below would keep
  // hitting ESI for the rest of the session once the page has been visited,
  // burning the ESI error budget for an invisible panel. Mirrors DpsPage.
  const active = useContext(ModuleActiveContext);

  const [text, setText] = useState("");
  const [settings, dispatchSettings] = useReducer(
    alarmSettingsReducer,
    undefined,
    initAlarmSettings,
  );
  const flashTimerRef = useRef<number | undefined>(undefined);
  const triggerAlarm = useCallback(() => {
    const played = playAlarm();
    dispatchSettings({ type: "setAudioUnavailable", value: !played });
    if (!played) {
      dispatchSettings({ type: "setFlashAlert", value: true });
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = window.setTimeout(
        () => dispatchSettings({ type: "setFlashAlert", value: false }),
        900,
      );
    }
  }, []);
  const setAlertAnyRed = useCallback((value: boolean) => {
    dispatchSettings({ type: "setAlertAnyRed", value });
  }, []);
  const setAlertNeutrals = useCallback((value: boolean) => {
    dispatchSettings({ type: "setAlertNeutrals", value });
    localStorage.setItem(
      STORAGE_KEYS.localintelAlertNeutrals,
      value ? "on" : "off",
    );
  }, []);
  const setSoundOn = useCallback(
    (value: boolean) => {
      dispatchSettings({ type: "setSoundOn", value });
      localStorage.setItem(STORAGE_KEYS.localintelSound, value ? "on" : "off");
      if (value) triggerAlarm();
    },
    [triggerAlarm],
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
        alertAnyRed: settings.alertAnyRed,
        alertNeutrals: settings.alertNeutrals,
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
      if (alarm && settings.soundOn) triggerAlarm();

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
  const onUnwatch = useCallback(
    (id: number, name: string) => watchMutate({ id, name, add: false }),
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
  const refreshNeighbourhood = useCallback(() => {
    void location.refetch();
    void hood.refetch();
  }, [location, hood]);

  return {
    active,
    text,
    setText,
    settings,
    setAlertAnyRed,
    setAlertNeutrals,
    setSoundOn,
    triggerAlarm,
    logsDir,
    setLogsDir,
    loadLog,
    watchlist,
    onUnwatch,
    zkill,
    zkillRun,
    scan,
    result,
    newIds,
    isWatched,
    onWatch,
    hostileCorps,
    watchIds,
    hoodDepth,
    setHoodDepth,
    here,
    hoodNodes: hood.data?.nodes,
    neighbourhoodLoading: location.isFetching || hood.isFetching,
    locationError: location.isError,
    refreshNeighbourhood,
  };
}
