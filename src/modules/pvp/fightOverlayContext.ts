import { createContext, useContext } from "react";

/** Combat-recording hook settings (#1014): when enabled, the overlay runs
 *  `startCommand` the moment a fight is detected and `endCommand` once the
 *  fight freezes (plus `postRollSecs`) — both through the platform shell,
 *  with `{start}`/`{end}` substituted with the fight's epoch bounds. */
export interface FightRecordingSettings {
  enabled: boolean;
  startCommand: string;
  endCommand: string;
  postRollSecs: number;
  /** Drive OBS over obs-websocket (#1015): SaveReplayBuffer + StartRecord on
   *  fight start, StopRecord on fight end. Independent of the command hooks —
   *  either or both can be active. */
  obsEnabled: boolean;
  obsUrl: string;
  obsPassword: string;
}

export const DEFAULT_FIGHT_RECORDING: FightRecordingSettings = {
  enabled: false,
  startCommand: "",
  endCommand: "",
  postRollSecs: 10,
  obsEnabled: false,
  obsUrl: "ws://127.0.0.1:4455",
  obsPassword: "",
};

export interface FightOverlayCtx {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Pop the overlay with random sample data so you can preview it without a
   *  real fight (the Settings "Test" button). */
  runTest: () => void;
  /** Fight-recording hooks — state lives in the provider so Settings and the
   *  overlay always agree (same pattern as `enabled`). */
  recording: FightRecordingSettings;
  setRecording: (s: FightRecordingSettings) => void;
}

export const FightOverlayContext = createContext<FightOverlayCtx>({
  enabled: false,
  setEnabled: () => {},
  runTest: () => {},
  recording: DEFAULT_FIGHT_RECORDING,
  setRecording: () => {},
});

export function useFightOverlay(): FightOverlayCtx {
  return useContext(FightOverlayContext);
}
