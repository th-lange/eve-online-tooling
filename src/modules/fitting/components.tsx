// Barrel for the Fitting module's presentational components. The actual
// implementations live in focused files (ModuleBrowser / SlotGrid /
// StatsPanels / ProjectedPanel / fitHelpers); this keeps existing import
// sites working unchanged.

import type { ReactNode } from "react";
import { errorMessage, isAuthRequired, type Fit } from "../../lib/api";

export { BrowseTree, ModuleBrowser } from "./ModuleBrowser";
export { ProjectedPanel } from "./ProjectedPanel";
export { ChargeControl, SlotBadge, SlotGrid } from "./SlotGrid";
export {
  CapChart,
  CapGauge,
  EwPanel,
  ResourceBar,
  TankResists,
} from "./StatsPanels";
export { FIT_EPS, type FitContext } from "./fitHelpers";

/** In-game fittings status: an error (e.g. missing scope) or "none found". */
export function EsiFitStatus({
  esi,
  refresh,
}: {
  esi: { data?: Fit[]; error: unknown; isFetched: boolean };
  refresh: { error: unknown };
}) {
  const err = refresh.error ?? esi.error;
  if (err) {
    return (
      <span
        className={`mt-0.5 block w-72 text-[11px] ${
          isAuthRequired(err) ? "text-zinc-500" : "text-rose-400"
        }`}
      >
        {isAuthRequired(err)
          ? "Log in a character first to load in-game fittings."
          : errorMessage(err)}
      </span>
    );
  }
  if (esi.isFetched && (esi.data?.length ?? 0) === 0) {
    return (
      <span className="mt-0.5 block text-[11px] text-zinc-500">
        No in-game fittings for this character.
      </span>
    );
  }
  return null;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
      {children}
    </div>
  );
}
