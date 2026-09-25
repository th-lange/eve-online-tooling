import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  fittingShipLayout,
  fittingSimulate,
  sdeTypeNames,
  type FitStats,
  type ShipLayout,
  type SlotKind,
  type WeaponRange,
} from "../../lib/api";
import type { FitStateSlice } from "./useFitCoreState";
import type { FitContext } from "./fitHelpers";

/** The fit-editing state machine's derived simulation: layout/stats queries
 *  keyed off `FitStateSlice`, and the small lookups (names, ranges,
 *  activatable types, free-slot/CPU/PG context) every consumer re-derives
 *  from the same simulate result. Pure read side — see `useFitCoreMutations`
 *  for anything that writes back to the fit. */
export interface FitStatsSlice {
  layout: UseQueryResult<ShipLayout | null, Error>;
  nameOf: (id: number) => string;
  stats: UseQueryResult<FitStats, Error>;
  jammedActive: boolean;
  rangeOf: Map<string, WeaponRange>;
  activatable: Set<number>;
  fitContext: FitContext | null;
}

/** Raw derived-stats slice — see `useFitCoreState` for the sibling raw state
 *  slice this reads from. Called once by `FitEditorProvider`. */
export function useFitCoreStats(state: FitStateSlice): FitStatsSlice {
  const {
    fit,
    skillSource,
    damageProfile,
    neutGjs,
    targetProfile,
    fleetBoosts,
    environmentEffect,
    abyssalWeather,
    spoolPct,
    factorReload,
    jammed,
  } = state;

  const layout = useQuery({
    queryKey: ["fitting", "layout", fit?.shipTypeId],
    queryFn: fit ? () => fittingShipLayout(fit.shipTypeId) : undefined,
    enabled: fit != null,
  });

  // Names for every fitted type id (+ charges), to show names not ids.
  const itemIds = useMemo(() => {
    if (!fit) return [];
    const s = new Set<number>([fit.shipTypeId]);
    for (const it of fit.items) {
      s.add(it.typeId);
      if (it.chargeTypeId) s.add(it.chargeTypeId);
    }
    for (const it of fit.projected ?? []) s.add(it.typeId);
    for (const b of fleetBoosts) {
      s.add(b.moduleTypeId);
      if (b.chargeTypeId) s.add(b.chargeTypeId);
    }
    return [...s];
  }, [fit, fleetBoosts]);
  const names = useQuery({
    queryKey: ["fitting", "names", itemIds],
    queryFn: () => sdeTypeNames(itemIds),
    enabled: itemIds.length > 0,
  });
  const nameMap = useMemo(
    () => new Map((names.data ?? []).map((n) => [n.id, n.name])),
    [names.data],
  );
  const nameOf = (id: number) => nameMap.get(id) ?? `#${id}`;

  const fitKey = useMemo(() => (fit ? JSON.stringify(fit) : ""), [fit]);
  const stats = useQuery({
    queryKey: [
      "fitting",
      "simulate",
      fitKey,
      skillSource,
      damageProfile,
      neutGjs,
      targetProfile,
      fleetBoosts,
      environmentEffect,
      abyssalWeather,
      spoolPct,
      factorReload,
    ],
    queryFn: fit
      ? () =>
          fittingSimulate(
            fit,
            skillSource,
            damageProfile,
            neutGjs,
            targetProfile,
            fleetBoosts.length > 0 ? fleetBoosts : undefined,
            environmentEffect,
            abyssalWeather,
            spoolPct,
            factorReload,
          )
      : undefined,
    enabled: fit != null,
  });
  // The jammed view only applies while ECM is actually projected onto the fit.
  const jammedActive = jammed && !!stats.data?.projectedEw?.some((t) => t.jam);
  // Per-weapon ranges keyed by (typeId, chargeTypeId), for the slot grid.
  const rangeOf = useMemo(() => {
    const m = new Map<string, WeaponRange>();
    for (const r of stats.data?.weaponRanges ?? [])
      m.set(`${r.typeId}:${r.chargeTypeId ?? 0}`, r);
    return m;
  }, [stats.data?.weaponRanges]);
  // Module type ids that can be activated (others are passive — no active state).
  const activatable = useMemo(
    () => new Set(stats.data?.activatableTypes ?? []),
    [stats.data?.activatableTypes],
  );

  // What the hull has free right now — drives fit-aware ranking/filtering in the
  // add-module browser. Prefer the resolved (skill-adjusted) layout/resources.
  const fitContext = useMemo<FitContext | null>(() => {
    if (!fit) return null;
    const ship = stats.data?.layout ?? layout.data;
    if (!ship) return null;
    const used: Partial<Record<SlotKind, number>> = {};
    for (const it of fit.items) used[it.slot] = (used[it.slot] ?? 0) + 1;
    const free = (kind: SlotKind, total: number) =>
      Math.max(0, total - (used[kind] ?? 0));
    const res = stats.data?.resources;
    return {
      freeSlots: {
        high: free("high", ship.highSlots),
        mid: free("mid", ship.midSlots),
        low: free("low", ship.lowSlots),
        rig: free("rig", ship.rigSlots),
        subsystem: free("subsystem", ship.subsystemSlots),
        mode: free("mode", ship.modeSlots),
        fighter: free("fighter", ship.fighterTubes),
      },
      cpu: (res?.cpuOutput ?? ship.cpuOutput) - (res?.cpuUsed ?? 0),
      pg:
        (res?.powergridOutput ?? ship.powergridOutput) -
        (res?.powergridUsed ?? 0),
      calibration:
        (res?.calibrationOutput ?? ship.calibration) -
        (res?.calibrationUsed ?? 0),
    };
  }, [fit, stats.data, layout.data]);

  return {
    layout,
    nameOf,
    stats,
    jammedActive,
    rangeOf,
    activatable,
    fitContext,
  };
}
