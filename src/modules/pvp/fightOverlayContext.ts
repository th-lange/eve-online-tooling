import { createContext, useContext } from "react";

export interface FightOverlayCtx {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
}

export const FightOverlayContext = createContext<FightOverlayCtx>({
  enabled: false,
  setEnabled: () => {},
});

export function useFightOverlay(): FightOverlayCtx {
  return useContext(FightOverlayContext);
}
