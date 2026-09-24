import { createContext } from "react";
import type { FitStateSlice } from "./useFitCoreState";
import type { FitStatsSlice } from "./useFitCoreStats";
import type { FitMutationsSlice } from "./useFitCoreMutations";

// The raw context objects backing `FitEditorContext`'s provider and
// `useFitEditorContext`'s consumer hooks — split into their own
// (non-component) file so `FitEditorContext.tsx` exports only the
// `FitEditorProvider` component (react-refresh wants component-only files).
export const FitStateContext = createContext<FitStateSlice | null>(null);
export const FitStatsContext = createContext<FitStatsSlice | null>(null);
export const FitMutationsContext = createContext<FitMutationsSlice | null>(
  null,
);
