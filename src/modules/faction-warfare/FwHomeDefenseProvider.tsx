import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  authCharacters,
  fwSystems,
  intelFwEnlistment,
  intelFwJumps,
  onZkillKill,
} from "../../lib/api";
import { authKeys, intelKeys } from "../../lib/queryKeys";
import { usePersistentState } from "../../lib/usePersistentState";
import { FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS } from "../../lib/refreshIntervals";
import { useZkillStreamLease } from "../../lib/useZkillStream";
import {
  isMilitiaFaction,
  warzoneForFaction,
  type MilitiaFactionId,
} from "./factionPerspective";
import {
  detectHomeDefenseAlerts,
  shouldTriggerLiveRefetch,
  snapshotSystems,
  type NearbyFlipRadius,
  type SystemStateSnapshot,
} from "./homeDefenseAlerts";
import { FwHomeDefenseContext } from "./fwHomeDefenseContext";

const EMPTY_DIST: Record<string, number> = {};
/** Don't let a real fight (several kills a minute) hammer ESI with a
 *  refetch per kill — one eager re-check per system-of-interest per this
 *  window is enough to meaningfully cut alert latency without spamming. */
const KILL_TRIGGERED_REFETCH_COOLDOWN_MS = 30_000;

/** Best-effort desktop notification — mirrors the private helper in
 *  useLocalIntelData.ts (not exported there, so duplicated rather than
 *  reaching across an unrelated module for a 6-line wrapper). */
async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications unavailable — nothing else to fall back to here */
  }
}

/**
 * Root-level provider (#907) for FW home-defense alerts: "a friendly system
 * went vulnerable" and "a nearby system flipped contested state". Mounted at
 * the app root (alongside {@link FightOverlayProvider}) so it keeps
 * evaluating no matter which module is on screen, the same pattern used
 * there.
 *
 * Reuses the exact same queries (same `queryKey`s, same `staleTime`s) the FW
 * page's own Warzone view already runs, rather than introducing a new
 * polling cadence: `["intel","fwSystems"]` for system state, and the jump
 * distance lookup at the same `FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS`
 * cadence Warzone already uses for that identical ESI-backed lookup — no
 * additional call frequency is introduced, only reused. The jump-distance
 * query only runs at all while the nearby-flip rule is enabled.
 *
 * Reads the "fw.militia" localStorage key directly (same key the FW page's
 * militia picker persists to) rather than sharing React state, so this
 * provider works independently of whether the FW page is mounted.
 */
export function FwHomeDefenseProvider({ children }: { children: ReactNode }) {
  const [vulnerableAlertOn, setVulnerableAlertOn] = usePersistentState<boolean>(
    "fw.homeDefense.vulnerableAlert",
    true,
  );
  const [nearbyFlipRadius, setNearbyFlipRadius] =
    usePersistentState<NearbyFlipRadius>(
      "fw.homeDefense.nearbyFlipRadius",
      "5",
    );

  // Same militia resolution as FactionWarfarePage (#901): an explicit
  // override (including explicit Observer) wins, else auto-detect from the
  // enlisted character.
  const [override] = usePersistentState<"observer" | MilitiaFactionId | null>(
    "fw.militia",
    null,
  );
  const characters = useQuery({
    queryKey: authKeys.characters,
    queryFn: authCharacters,
  });
  const hasCharacter = (characters.data?.length ?? 0) > 0;
  const rulesEnabled = vulnerableAlertOn || nearbyFlipRadius !== "off";
  const enlistment = useQuery({
    queryKey: intelKeys.fwEnlistment,
    queryFn: intelFwEnlistment,
    enabled: hasCharacter && rulesEnabled,
    staleTime: 10 * 60_000,
  });
  const autoMilitia: MilitiaFactionId | null =
    enlistment.data != null && isMilitiaFaction(enlistment.data)
      ? enlistment.data
      : null;
  const myFaction: MilitiaFactionId | null =
    override != null && override !== "observer" ? override : autoMilitia;

  const map = useQuery({
    queryKey: intelKeys.fwSystems,
    queryFn: fwSystems,
    staleTime: 5 * 60_000,
    enabled: myFaction != null && rulesEnabled,
  });

  // Only the militia's own warzone matters for either rule.
  const myWarzoneSystems = useMemo(() => {
    if (!myFaction || !map.data) return [];
    const zone = warzoneForFaction(myFaction);
    return map.data.nodes.filter((n) => n.warzone === zone);
  }, [map.data, myFaction]);
  const systemIds = useMemo(
    () => myWarzoneSystems.map((s) => s.systemId),
    [myWarzoneSystems],
  );

  const jumpsEnabled =
    hasCharacter && nearbyFlipRadius !== "off" && systemIds.length > 0;
  const jumpResult = useQuery({
    queryKey: intelKeys.fwJumps(systemIds),
    queryFn: () => intelFwJumps(systemIds),
    enabled: jumpsEnabled,
    staleTime: FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS,
    refetchInterval: FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS,
  });
  const dist = useMemo(
    () => jumpResult.data?.jumps ?? EMPTY_DIST,
    [jumpResult.data],
  );

  const prevRef = useRef<Map<number, SystemStateSnapshot> | null>(null);
  useEffect(() => {
    if (!myFaction || myWarzoneSystems.length === 0) return;
    const alerts = detectHomeDefenseAlerts(
      prevRef.current,
      myWarzoneSystems,
      myFaction,
      dist,
      { vulnerableAlertOn, nearbyFlipRadius },
    );
    prevRef.current = snapshotSystems(myWarzoneSystems);
    for (const a of alerts) {
      if (a.kind === "vulnerable") {
        void notify(
          "⚠️ Home system vulnerable",
          `${a.systemName} is now vulnerable — defend it!`,
        );
      } else {
        void notify(
          "FW: nearby system flipped",
          `${a.systemName} is now ${a.contested}`,
        );
      }
    }
  }, [myWarzoneSystems, myFaction, dist, vulnerableAlertOn, nearbyFlipRadius]);

  // Live-triggered eager refetch (#926): a kill in a watched system is a
  // strong signal something's changing there right now, worth checking
  // sooner than the next scheduled poll (there isn't a fixed interval on
  // `fwSystems` at all today — it otherwise only refetches on focus/mount).
  // Doesn't skip the real check: `map.refetch()` still does a genuine
  // `/fw/systems/` fetch, so the actual vulnerable/flip detection above
  // still runs against real data once it lands — this only changes *when*
  // that happens.
  const lastTriggeredAtRef = useRef(-Infinity);
  const watchedSystemIds = useMemo(
    () => new Set(myWarzoneSystems.map((s) => s.systemId)),
    [myWarzoneSystems],
  );
  // The kill listener below only matters while home-defense rules are armed
  // with systems to watch — hold the killstream lease under that same
  // condition (#1060), so an idle app doesn't keep the websocket up.
  useZkillStreamLease(rulesEnabled && watchedSystemIds.size > 0);
  useEffect(() => {
    if (!rulesEnabled || watchedSystemIds.size === 0) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onZkillKill((event) => {
      if (
        shouldTriggerLiveRefetch(
          event.solarSystemId,
          watchedSystemIds,
          lastTriggeredAtRef.current,
          Date.now(),
          KILL_TRIGGERED_REFETCH_COOLDOWN_MS,
        )
      ) {
        lastTriggeredAtRef.current = Date.now();
        void map.refetch();
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [rulesEnabled, watchedSystemIds, map]);

  return (
    <FwHomeDefenseContext.Provider
      value={{
        vulnerableAlertOn,
        setVulnerableAlertOn,
        nearbyFlipRadius,
        setNearbyFlipRadius,
      }}
    >
      {children}
    </FwHomeDefenseContext.Provider>
  );
}
