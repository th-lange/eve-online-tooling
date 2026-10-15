import { useMemo, type ReactNode } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import {
  DEFAULT_FIGHT_RECORDING,
  migrateRecordingSettings,
  RecordingContext,
  type FightRecordingSettings,
} from "./recordingContext";

/** Owns the persisted combat-recording settings (#1013). Mounted at the app
 *  root so the Settings page and the fight overlay's recorder trigger share
 *  one state. */
export function RecordingProvider({ children }: { children: ReactNode }) {
  const [storedRecording, setRecording] = usePersistentState<unknown>(
    STORAGE_KEYS.fightRecording,
    DEFAULT_FIGHT_RECORDING,
  );
  // Whatever shape is persisted (legacy flat #1014-#1016 layout, or a build
  // with fewer per-provider fields) normalises to the current one.
  const recording: FightRecordingSettings = useMemo(
    () => migrateRecordingSettings(storedRecording),
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
