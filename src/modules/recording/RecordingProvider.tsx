import { useMemo, type ReactNode } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import {
  DEFAULT_FIGHT_RECORDING,
  RecordingContext,
  type FightRecordingSettings,
} from "./recordingContext";

/** Owns the persisted combat-recording settings (#1013). Mounted at the app
 *  root so the Settings page and the fight overlay's recorder trigger share
 *  one state. */
export function RecordingProvider({ children }: { children: ReactNode }) {
  const [storedRecording, setRecording] =
    usePersistentState<FightRecordingSettings>(
      STORAGE_KEYS.fightRecording,
      DEFAULT_FIGHT_RECORDING,
    );
  // Settings persisted by an older build miss newer fields — overlay defaults.
  const recording: FightRecordingSettings = useMemo(
    () => ({ ...DEFAULT_FIGHT_RECORDING, ...storedRecording }),
    [storedRecording],
  );
  const value = useMemo(
    () => ({ recording, setRecording }),
    [recording, setRecording],
  );
  return (
    <RecordingContext.Provider value={value}>
      {children}
    </RecordingContext.Provider>
  );
}
