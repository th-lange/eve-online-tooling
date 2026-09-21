import { createContext, useContext } from "react";

export interface FightOverlayCtx {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Pop the overlay with random sample data so you can preview it without a
   *  real fight (the Settings "Test" button). */
  runTest: () => void;
}

export const FightOverlayContext = createContext<FightOverlayCtx>({
  enabled: false,
  setEnabled: () => {},
  runTest: () => {},
});

export function useFightOverlay(): FightOverlayCtx {
  return useContext(FightOverlayContext);
}
