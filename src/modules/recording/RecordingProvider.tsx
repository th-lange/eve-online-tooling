import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import {
  DEFAULT_FIGHT_RECORDING,
  migrateRecordingSettings,
  RecordingContext,
  type FightRecordingSettings,
  type RecordingTestPhase,
} from "./recordingContext";
import { fireFightStart, fireFightEnd } from "./useFightRecorder";

/** Seconds the Settings "Test recording" pretends the fight lasts before the
 *  post-roll kicks in. */
export const TEST_FIGHT_SECS = 5;

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

  // Settings "Test recording": a synthetic fight through the real provider
  // actions — same start/stop calls, same post-roll — minus fight detection.
  const [recordingTestPhase, setRecordingTestPhase] =
    useState<RecordingTestPhase>(null);
  const testRunning = useRef(false);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const runRecordingTest = useCallback(() => {
    if (testRunning.current) return;
    testRunning.current = true;
    const settings = recordingRef.current;
    const start = Math.floor(Date.now() / 1000);
    fireFightStart(settings, start);
    setRecordingTestPhase("recording");
    window.setTimeout(() => {
      const end = Math.floor(Date.now() / 1000);
      setRecordingTestPhase("post-roll");
      window.setTimeout(() => {
        fireFightEnd(settings, start, end, []);
        setRecordingTestPhase(null);
        testRunning.current = false;
      }, settings.postRollSecs * 1000);
    }, TEST_FIGHT_SECS * 1000);
  }, []);

  const value = useMemo(
    () => ({ recording, setRecording, runRecordingTest, recordingTestPhase }),
    [recording, setRecording, runRecordingTest, recordingTestPhase],
  );
  return (
    <RecordingContext.Provider value={value}>
      {children}
    </RecordingContext.Provider>
  );
}
