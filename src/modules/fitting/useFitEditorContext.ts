import { useContext } from "react";
import {
  FitMutationsContext,
  FitStateContext,
  FitStatsContext,
} from "./fitEditorContexts";
import type { FitStateSlice } from "./useFitCoreState";
import type { FitStatsSlice } from "./useFitCoreStats";
import type { FitMutationsSlice } from "./useFitCoreMutations";

function required<T>(value: T | null, hookName: string): T {
  if (value == null) {
    throw new Error(`${hookName} must be used within a FitEditorProvider`);
  }
  return value;
}

/** The fit's raw client-side state (fit/setFit, eft, skills, jam, damage
 *  profile, target, fleet boosts, environment) — see `FitStateSlice`. */
export function useFitState(): FitStateSlice {
  return required(useContext(FitStateContext), "useFitState");
}

/** The fit's derived simulation (layout, stats, names, ranges, activatable
 *  types, free-slot/CPU/PG context) — see `FitStatsSlice`. */
export function useFitStats(): FitStatsSlice {
  return required(useContext(FitStatsContext), "useFitStats");
}

/** The fit's write side — client-side slot edits plus backend-round-tripping
 *  mutations (add item, import/export EFT, save) — see `FitMutationsSlice`. */
export function useFitMutations(): FitMutationsSlice {
  return required(useContext(FitMutationsContext), "useFitMutations");
}
