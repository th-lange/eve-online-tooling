import { createContext, useContext } from "react";

/** Combat-recording settings (#1013): when enabled, a detected fight starts
 *  an external recorder and its freeze (plus `postRollSecs`) stops it — via
 *  shell command hooks (#1014), obs-websocket (#1015), or both. */
export interface FightRecordingSettings {
  enabled: boolean;
  /** Shell hooks run through the platform shell with `{start}`/`{end}`
   *  substituted with the fight's epoch bounds; empty = skipped. */
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

/** State lives in `RecordingProvider` so Settings and the fight overlay
 *  always agree (`usePersistentState` has no cross-instance sync). */
export interface RecordingCtx {
  recording: FightRecordingSettings;
  setRecording: (s: FightRecordingSettings) => void;
}

export const RecordingContext = createContext<RecordingCtx>({
  recording: DEFAULT_FIGHT_RECORDING,
  setRecording: () => {},
});

export function useRecording(): RecordingCtx {
  return useContext(RecordingContext);
}
