import { useEffect, useRef } from "react";
import {
  recordingRunHook,
  obsFightStarted,
  obsFightEnded,
  recordingWriteSidecar,
  errorMessage,
  type DpsBucket,
} from "../../lib/api";
import { useRecording, type FightRecordingSettings } from "./recordingContext";

/** Fill a recording hook command's placeholders (#1014): `{start}`/`{end}`
 *  become the fight's epoch-second bounds (empty string while unknown).
 *  Returns `""` for a blank command so callers can skip the spawn entirely.
 *  Exported for tests. */
export function substituteHookVars(
  command: string,
  vars: { start?: number | null; end?: number | null },
): string {
  const cmd = command.trim();
  if (!cmd) return "";
  return cmd
    .replaceAll("{start}", vars.start == null ? "" : String(vars.start))
    .replaceAll("{end}", vars.end == null ? "" : String(vars.end));
}

/** Fire every enabled provider's fight-start action. Shared by the live
 *  trigger below and the Settings "Test recording" run. A provider failure
 *  never blocks the others — it's logged with context and, when `onError`
 *  is given, surfaced to the recording status so a silently-unrecorded
 *  fight isn't discovered only after the fact. */
export function fireFightStart(
  recording: FightRecordingSettings,
  startTs: number | null,
  onError?: (message: string) => void,
): void {
  if (recording.hooks.enabled) {
    const cmd = substituteHookVars(recording.hooks.startCommand, {
      start: startTs,
    });
    if (cmd)
      void recordingRunHook(cmd).catch((e) => {
        const message = `Recording start hook failed: ${errorMessage(e)}`;
        console.error(message, e);
        onError?.(message);
      });
  }
  if (recording.obs.enabled)
    void obsFightStarted({
      url: recording.obs.url,
      password: recording.obs.password || undefined,
    }).catch((e) => {
      const message = `OBS recording start failed: ${errorMessage(e)}`;
      console.error(message, e);
      onError?.(message);
    });
}

/** Fire every enabled provider's fight-end action; when OBS reports the
 *  finished clip's path, the fight sidecar summarising `buckets` is written
 *  next to it (#1016). Same failure handling as {@link fireFightStart}. */
export function fireFightEnd(
  recording: FightRecordingSettings,
  startTs: number | null,
  endTs: number | null,
  buckets: DpsBucket[],
  onError?: (message: string) => void,
): void {
  if (recording.hooks.enabled) {
    const cmd = substituteHookVars(recording.hooks.endCommand, {
      start: startTs,
      end: endTs,
    });
    if (cmd)
      void recordingRunHook(cmd).catch((e) => {
        const message = `Recording end hook failed: ${errorMessage(e)}`;
        console.error(message, e);
        onError?.(message);
      });
  }
  if (recording.obs.enabled)
    void obsFightEnded({
      url: recording.obs.url,
      password: recording.obs.password || undefined,
    })
      .then((clip) => {
        if (!clip) return;
        const attackers = new Map<string, string | undefined>();
        let damageOut = 0;
        let damageIn = 0;
        for (const b of buckets) {
          damageOut += b.damageOut;
          damageIn += b.damageIn;
          for (const p of b.byPilot) {
            if (p.dpsIn > 0 && p.ship) attackers.set(p.name, p.ship);
          }
        }
        return recordingWriteSidecar(clip, {
          start: startTs,
          end: endTs,
          damageOut,
          damageIn,
          attackers: [...attackers].map(([name, ship]) => ({ name, ship })),
        });
      })
      .catch((e) => {
        const message = `OBS recording stop failed: ${errorMessage(e)}`;
        console.error(message, e);
        onError?.(message);
      });
}

/** The combat-recording trigger (#1013), fed by the fight overlay's
 *  detection: providers start on `fightLive`'s rising edge and stop after
 *  the post-roll — unless the fight re-engages within it, in which case the
 *  recording just keeps rolling. Turning the setting off mid-fight stops
 *  immediately. */
export function useFightRecorder(fight: {
  live: boolean;
  startTs: number | null;
  endTs: number | null;
  buckets: DpsBucket[];
  /** Character whose gamelog the capture follows (`dps://source`); null
   *  while unknown. */
  character: string | null;
}): void {
  const { recording, setRecordingError } = useRecording();
  const { live, startTs, endTs, buckets } = fight;
  // Character filter: when set, only that character's fights record. An
  // unknown capture character fails a set filter (conservative — better to
  // miss a clip than record the wrong account's fight).
  const wanted = recording.character.trim().toLowerCase();
  const characterOk =
    !wanted || (fight.character ?? "").trim().toLowerCase() === wanted;
  const recRef = useRef<{
    active: boolean;
    endTimer: number | null;
  }>({ active: false, endTimer: null });
  useEffect(() => {
    const rec = recRef.current;
    if (recording.enabled && live && characterOk) {
      if (rec.endTimer) {
        // Re-engaged within the post-roll: cancel the pending stop and keep
        // the running recording instead of restarting it.
        clearTimeout(rec.endTimer);
        rec.endTimer = null;
        rec.active = true;
        return;
      }
      if (!rec.active) {
        rec.active = true;
        setRecordingError(null);
        fireFightStart(recording, startTs, setRecordingError);
      }
    } else if (rec.active) {
      rec.active = false;
      // The freeze render captured the final (frozen) fight buffer — the
      // sidecar summarises exactly what the clip shows (#1016).
      const frozen = buckets;
      const runEnd = () => {
        setRecordingError(null);
        fireFightEnd(recording, startTs, endTs, frozen, setRecordingError);
      };
      if (!recording.enabled) {
        runEnd(); // setting switched off mid-fight: stop right away
      } else {
        rec.endTimer = window.setTimeout(() => {
          rec.endTimer = null;
          runEnd();
        }, recording.postRollSecs * 1000);
      }
    }
  }, [
    live,
    characterOk,
    recording,
    startTs,
    endTs,
    buckets,
    setRecordingError,
  ]);
}
