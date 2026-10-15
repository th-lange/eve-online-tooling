import { createContext, useContext } from "react";

/** Combat recording (#1013) is driven by **providers** — independent ways of
 *  controlling an external recorder. Each can be enabled on its own; any
 *  combination runs when a fight is detected. */

/** Provider: OBS over obs-websocket v5 (#1015) — SaveReplayBuffer +
 *  StartRecord on fight start, StopRecord on fight end (then the fight
 *  sidecar is written next to the clip, #1016). */
export interface ObsProviderSettings {
  enabled: boolean;
  url: string;
  password: string;
}

/** Provider: shell command hooks (#1014) for any CLI-driven recorder — run
 *  through the platform shell with `{start}`/`{end}` substituted with the
 *  fight's epoch bounds; an empty command is skipped. */
export interface HooksProviderSettings {
  enabled: boolean;
  startCommand: string;
  endCommand: string;
}

export interface FightRecordingSettings {
  /** Master switch: nothing records while off, whatever providers say. */
  enabled: boolean;
  /** Seconds to keep recording after the fight goes quiet; re-engaging
   *  within the window keeps the same recording rolling. */
  postRollSecs: number;
  obs: ObsProviderSettings;
  hooks: HooksProviderSettings;
}

export const DEFAULT_FIGHT_RECORDING: FightRecordingSettings = {
  enabled: false,
  postRollSecs: 10,
  obs: {
    enabled: false,
    url: "ws://127.0.0.1:4455",
    password: "",
  },
  hooks: {
    enabled: false,
    startCommand: "",
    endCommand: "",
  },
};

/** Normalise whatever is persisted under the recording key into the current
 *  shape: the pre-provider flat layout (#1014–#1016 releases) is mapped onto
 *  provider blocks — hooks count as enabled when a command was configured,
 *  since that was the old activation rule — and missing fields (older builds)
 *  fall back to defaults. */
export function migrateRecordingSettings(
  stored: unknown,
): FightRecordingSettings {
  if (typeof stored !== "object" || stored === null)
    return DEFAULT_FIGHT_RECORDING;
  const s = stored as Record<string, unknown>;
  const base: FightRecordingSettings = {
    ...DEFAULT_FIGHT_RECORDING,
    enabled: typeof s.enabled === "boolean" ? s.enabled : false,
    postRollSecs:
      typeof s.postRollSecs === "number"
        ? s.postRollSecs
        : DEFAULT_FIGHT_RECORDING.postRollSecs,
  };
  if (typeof s.obs === "object" || typeof s.hooks === "object") {
    // Current shape (possibly from a build with fewer per-provider fields).
    return {
      ...base,
      obs: {
        ...DEFAULT_FIGHT_RECORDING.obs,
        ...(s.obs as Partial<ObsProviderSettings> | undefined),
      },
      hooks: {
        ...DEFAULT_FIGHT_RECORDING.hooks,
        ...(s.hooks as Partial<HooksProviderSettings> | undefined),
      },
    };
  }
  // Legacy flat shape.
  const startCommand = typeof s.startCommand === "string" ? s.startCommand : "";
  const endCommand = typeof s.endCommand === "string" ? s.endCommand : "";
  return {
    ...base,
    obs: {
      enabled: s.obsEnabled === true,
      url:
        typeof s.obsUrl === "string" && s.obsUrl
          ? s.obsUrl
          : DEFAULT_FIGHT_RECORDING.obs.url,
      password: typeof s.obsPassword === "string" ? s.obsPassword : "",
    },
    hooks: {
      enabled: Boolean(startCommand.trim() || endCommand.trim()),
      startCommand,
      endCommand,
    },
  };
}

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
