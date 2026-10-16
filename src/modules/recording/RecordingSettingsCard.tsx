import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  errorMessage,
  obsTestConnection,
  dpsListCharacters,
} from "../../lib/api";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { useRecording } from "./recordingContext";

/** One-time external setup the app cannot do for the user — linked from the
 *  OBS provider section. */
const SETUP_GUIDE_URL =
  "https://github.com/th-lange/eve-online-tooling/blob/main/docs/combat-recording.md";

/** The complete "Record fights" configuration — master switch, post-roll,
 *  and the per-provider sections (OBS, command hooks) with their test
 *  affordances. One shared component mounted by both the Recording page and
 *  the Settings page; state lives in `RecordingProvider`, so the two mounts
 *  can never disagree. */
export function RecordingSettingsCard() {
  const { recording, setRecording, runRecordingTest, recordingTestPhase } =
    useRecording();
  // OBS "Test connection" result — version string on success, error otherwise.
  const [obsStatus, setObsStatus] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  async function testObs() {
    setObsStatus(null);
    try {
      const version = await obsTestConnection({
        url: recording.obs.url,
        password: recording.obs.password || undefined,
      });
      setObsStatus({ ok: true, text: version });
    } catch (e) {
      setObsStatus({ ok: false, text: errorMessage(e) });
    }
  }

  // Known characters from the gamelogs folder, for the filter's datalist.
  const [gamelogsDir] = useEveLogDir("gamelogs");
  const characters = useQuery({
    queryKey: ["dps", "characters", gamelogsDir],
    queryFn: () => dpsListCharacters(gamelogsDir),
    enabled: gamelogsDir !== "",
    staleTime: 60_000,
  });

  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-zinc-100">
            Record fights
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            Start an external recorder automatically when the Combat Overview
            detects a fight and stop it when the fight goes quiet for 5 seconds
            (plus the post-roll). Pick one or both recording providers below.
          </span>
        </span>
        <input
          type="checkbox"
          checked={recording.enabled}
          onChange={(e) =>
            setRecording({ ...recording, enabled: e.currentTarget.checked })
          }
          className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
          aria-label="Record fights"
        />
      </div>
      {recording.enabled && (
        <div className="mt-3 grid gap-2">
          <label className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">
              Keep recording after the fight ends for
            </span>
            <input
              type="number"
              min={0}
              max={120}
              value={recording.postRollSecs}
              onChange={(e) =>
                setRecording({
                  ...recording,
                  postRollSecs: Math.max(
                    0,
                    Math.min(120, Number(e.currentTarget.value) || 0),
                  ),
                })
              }
              className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              aria-label="Post-roll seconds"
            />
            <span className="text-xs text-zinc-500">seconds</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-zinc-500">Only for character</span>
            <select
              value={recording.character}
              onChange={(e) =>
                setRecording({ ...recording, character: e.currentTarget.value })
              }
              className="w-56 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              aria-label="Only for character"
            >
              <option value="">any character</option>
              {(characters.data ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {recording.character &&
                !(characters.data ?? []).includes(recording.character) && (
                  // A previously saved choice whose logs aged out of the
                  // folder — keep it selectable instead of silently dropping.
                  <option value={recording.character}>
                    {recording.character} (no recent logs)
                  </option>
                )}
            </select>
            <span className="text-xs text-zinc-600">
              record only this character's fights (multi-boxing) — characters
              read from your gamelogs folder
            </span>
          </label>
          <div className="mt-1 border-t border-zinc-800 pt-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={recording.obs.enabled}
                onChange={(e) =>
                  setRecording({
                    ...recording,
                    obs: {
                      ...recording.obs,
                      enabled: e.currentTarget.checked,
                    },
                  })
                }
                className="h-4 w-4 cursor-pointer accent-indigo-500"
                aria-label="Provider: OBS"
              />
              <span className="text-xs text-zinc-300">
                <span className="font-medium text-zinc-200">Provider: OBS</span>{" "}
                (obs-websocket) — saves the replay buffer + starts recording on
                fight start, stops on fight end
              </span>
            </label>
            {recording.obs.enabled && (
              <p className="mt-1.5 text-xs text-zinc-500">
                OBS itself needs one-time setup — the app only starts and stops
                what OBS is configured to record: enable the WebSocket server
                (Tools → WebSocket Server Settings), add a scene capturing your
                EVE window, and turn on the Replay Buffer for the seconds before
                the fight.{" "}
                <button
                  type="button"
                  onClick={() => void openUrl(SETUP_GUIDE_URL).catch(() => {})}
                  className="text-indigo-400 underline hover:text-indigo-300"
                >
                  Setup guide
                </button>
              </p>
            )}
            {recording.obs.enabled && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={recording.obs.url}
                  onChange={(e) =>
                    setRecording({
                      ...recording,
                      obs: { ...recording.obs, url: e.currentTarget.value },
                    })
                  }
                  placeholder="ws://127.0.0.1:4455"
                  className="w-56 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
                  aria-label="OBS websocket URL"
                />
                <input
                  type="password"
                  value={recording.obs.password}
                  onChange={(e) =>
                    setRecording({
                      ...recording,
                      obs: {
                        ...recording.obs,
                        password: e.currentTarget.value,
                      },
                    })
                  }
                  placeholder="password (optional)"
                  className="w-44 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
                  aria-label="OBS websocket password"
                />
                <button
                  type="button"
                  onClick={testObs}
                  className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  Test connection
                </button>
                {obsStatus && (
                  <span
                    className={`text-xs ${
                      obsStatus.ok ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {obsStatus.text}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="mt-1 border-t border-zinc-800 pt-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={recording.hooks.enabled}
                onChange={(e) =>
                  setRecording({
                    ...recording,
                    hooks: {
                      ...recording.hooks,
                      enabled: e.currentTarget.checked,
                    },
                  })
                }
                className="h-4 w-4 cursor-pointer accent-indigo-500"
                aria-label="Provider: command hooks"
              />
              <span className="text-xs text-zinc-300">
                <span className="font-medium text-zinc-200">
                  Provider: command hooks
                </span>{" "}
                — run your own shell commands (any CLI recorder:
                gpu-screen-recorder, ffmpeg, …);
                <code className="mx-1 rounded bg-zinc-800 px-1">
                  {"{start}"}
                </code>
                and
                <code className="mx-1 rounded bg-zinc-800 px-1">{"{end}"}</code>
                become the fight's epoch seconds
              </span>
            </label>
            {recording.hooks.enabled && (
              <div className="mt-2 grid gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">
                    Fight start command
                  </span>
                  <input
                    type="text"
                    value={recording.hooks.startCommand}
                    onChange={(e) =>
                      setRecording({
                        ...recording,
                        hooks: {
                          ...recording.hooks,
                          startCommand: e.currentTarget.value,
                        },
                      })
                    }
                    placeholder="e.g. gpu-screen-recorder -w screen -o ~/Videos/eve-{start}.mp4 &"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
                    aria-label="Fight start command"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-zinc-500">
                    Fight end command
                  </span>
                  <input
                    type="text"
                    value={recording.hooks.endCommand}
                    onChange={(e) =>
                      setRecording({
                        ...recording,
                        hooks: {
                          ...recording.hooks,
                          endCommand: e.currentTarget.value,
                        },
                      })
                    }
                    placeholder="e.g. pkill -SIGINT gpu-screen-recorder"
                    className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600"
                    aria-label="Fight end command"
                  />
                </label>
              </div>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={runRecordingTest}
              disabled={recordingTestPhase != null}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-default disabled:opacity-50"
            >
              Test recording
            </button>
            <span className="text-xs text-zinc-500">
              {recordingTestPhase === "recording" &&
                "synthetic fight live (5 s) — providers started…"}
              {recordingTestPhase === "post-roll" &&
                `fight over — stopping after the ${recording.postRollSecs} s post-roll…`}
              {recordingTestPhase == null &&
                "runs a 5 s synthetic fight through the enabled providers"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
