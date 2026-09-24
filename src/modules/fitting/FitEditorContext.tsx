import type { ReactNode } from "react";
import {
  FitMutationsContext,
  FitStateContext,
  FitStatsContext,
} from "./fitEditorContexts";
import { useFitCoreState } from "./useFitCoreState";
import { useFitCoreStats } from "./useFitCoreStats";
import { useFitCoreMutations } from "./useFitCoreMutations";

/**
 * Wraps the fitting workbench: runs the fit-editing state machine once (the
 * former `useFitEditor` monolith, now split into `useFitCoreState` /
 * `useFitCoreStats` / `useFitCoreMutations`) and exposes each slice as its
 * own context, so a child that only reads `stats` doesn't re-render when a
 * sibling flips `jammed`, and so on (#842). Consume via `useFitState` /
 * `useFitStats` / `useFitMutations` from `useFitEditorContext`.
 */
export function FitEditorProvider({ children }: { children: ReactNode }) {
  const state = useFitCoreState();
  const stats = useFitCoreStats(state);
  const mutations = useFitCoreMutations(state);
  return (
    <FitStateContext.Provider value={state}>
      <FitStatsContext.Provider value={stats}>
        <FitMutationsContext.Provider value={mutations}>
          {children}
        </FitMutationsContext.Provider>
      </FitStatsContext.Provider>
    </FitStateContext.Provider>
  );
}
