import { createContext, useContext } from "react";

export interface FightOverlayCtx {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Pop the overlay with random sample data so you can preview it without a
   *  real fight (the Settings "Test" button). */
  runTest: () => void;
  /** Most recent failure starting the background live capture that backs
   *  the overlay (`dps_start`); `null` once it succeeds. Surfaced next to
   *  the "Display Combat Overview" toggle so a failed capture isn't
   *  discovered only when a fight never shows the overlay. */
  captureError: string | null;
}

export const FightOverlayContext = createContext<FightOverlayCtx>({
  enabled: false,
  setEnabled: () => {},
  runTest: () => {},
  captureError: null,
});

export function useFightOverlay(): FightOverlayCtx {
  return useContext(FightOverlayContext);
}
