import { useEffect, useRef } from "react";
import {
  recordingRunHook,
  obsFightStarted,
  obsFightEnded,
  recordingWriteSidecar,
  type DpsBucket,
} from "../../lib/api";
import { useRecording } from "./recordingContext";

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

/** The combat-recording trigger (#1013), fed by the fight overlay's
 *  detection: the start hook / OBS start fires on `fightLive`'s rising edge,
 *  the end hook / OBS stop after the post-roll — unless the fight re-engages
 *  within it, in which case the recording just keeps rolling. Turning the
 *  setting off mid-fight stops immediately. When OBS reports the finished
 *  clip's path, the fight sidecar is written next to it (#1016). Recorder
 *  failures never surface as overlay errors. */
export function useFightRecorder(fight: {
  live: boolean;
  startTs: number | null;
  endTs: number | null;
  buckets: DpsBucket[];
}): void {
  const { recording } = useRecording();
  const { live, startTs, endTs, buckets } = fight;
  const recRef = useRef<{
    active: boolean;
    endTimer: number | null;
  }>({ active: false, endTimer: null });
  useEffect(() => {
    const rec = recRef.current;
    if (recording.enabled && live) {
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
        const cmd = substituteHookVars(recording.startCommand, {
          start: startTs,
        });
        if (cmd) void recordingRunHook(cmd).catch(() => {});
        if (recording.obsEnabled)
          void obsFightStarted({
            url: recording.obsUrl,
            password: recording.obsPassword || undefined,
          }).catch(() => {});
      }
    } else if (rec.active) {
      rec.active = false;
      // The freeze render captured the final (frozen) fight buffer — the
      // sidecar summarises exactly what the clip shows (#1016).
      const frozen = buckets;
      const runEnd = () => {
        const cmd = substituteHookVars(recording.endCommand, {
          start: startTs,
          end: endTs,
        });
        if (cmd) void recordingRunHook(cmd).catch(() => {});
        if (recording.obsEnabled)
          void obsFightEnded({
            url: recording.obsUrl,
            password: recording.obsPassword || undefined,
          })
            .then((clip) => {
              if (!clip) return;
              const attackers = new Map<string, string | undefined>();
              let damageOut = 0;
              let damageIn = 0;
              for (const b of frozen) {
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
                attackers: [...attackers].map(([name, ship]) => ({
                  name,
                  ship,
                })),
              });
            })
            .catch(() => {});
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
  }, [live, recording, startTs, endTs, buckets]);
}
