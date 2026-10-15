import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { errorMessage, obsTestConnection } from "../../lib/api";
import { Page, PageHeader } from "../../components/page";
import { useFightOverlay } from "../pvp/fightOverlayContext";
import { useRecording } from "../recording/recordingContext";
import { useFwHomeDefense } from "../faction-warfare/fwHomeDefenseContext";
import type { NearbyFlipRadius } from "../faction-warfare/homeDefenseAlerts";
import { useCheckForUpdatesEnabled, useReleaseCheck } from "./useReleaseCheck";
import { useConfirmBeforeQuit } from "./useConfirmBeforeQuit";

const NEARBY_FLIP_OPTIONS: readonly { key: NearbyFlipRadius; label: string }[] =
  [
    { key: "3", label: "3j" },
    { key: "5", label: "5j" },
    { key: "10", label: "10j" },
    { key: "off", label: "Off" },
  ];

/**
 * App-wide preferences that don't belong to any one feature module. The
 * underlying state for each setting still lives where its behavior is
 * implemented (e.g. the fight overlay's `enabled` flag lives in
 * `FightOverlayProvider`, mounted at the app root) — this page is just a
 * discoverable, central place to flip them, alongside the PVP page's own
 * "Show fight overlay" checkbox.
 */
export function SettingsPage() {
  const {
    enabled: combatOverviewOn,
    setEnabled: setCombatOverviewOn,
    runTest,
  } = useFightOverlay();
  const { recording, setRecording, runRecordingTest, recordingTestPhase } =
    useRecording();
  const {
    vulnerableAlertOn,
    setVulnerableAlertOn,
    nearbyFlipRadius,
    setNearbyFlipRadius,
  } = useFwHomeDefense();
  const [checkForUpdates, setCheckForUpdates] = useCheckForUpdatesEnabled();
  const release = useReleaseCheck(checkForUpdates);
  const [confirmBeforeQuit, setConfirmBeforeQuit] = useConfirmBeforeQuit();
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

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="App-wide preferences that apply across every module."
      />
      <div className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40">
        <div className="flex items-start justify-between gap-4 p-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              Display Combat Overview
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Pop over live combat details — attackers, DPS, and their fits —
              the moment your gamelog shows you in a fight. Shown over every
              module, not just PVP.
            </span>
          </span>
          <div className="mt-1 flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={runTest}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title="Preview the overlay with random sample data"
            >
              Test
            </button>
            <input
              type="checkbox"
              checked={combatOverviewOn}
              onChange={(e) => setCombatOverviewOn(e.currentTarget.checked)}
              className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
              aria-label="Display Combat Overview"
            />
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-start justify-between gap-4">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-100">
                Record fights
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500">
                Start an external recorder automatically when the Combat
                Overview detects a fight and stop it when the fight goes quiet
                for 5 seconds (plus the post-roll). Pick one or both recording
                providers below.
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
                    <span className="font-medium text-zinc-200">
                      Provider: OBS
                    </span>{" "}
                    (obs-websocket) — saves the replay buffer + starts recording
                    on fight start, stops on fight end
                  </span>
                </label>
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
                    <code className="mx-1 rounded bg-zinc-800 px-1">
                      {"{end}"}
                    </code>
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
        <div className="flex items-start justify-between gap-4 p-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              FW: home system vulnerable
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Notify when a system your militia holds enters the vulnerable
              state. Shown over every module, not just Faction Warfare.
            </span>
          </span>
          <input
            type="checkbox"
            checked={vulnerableAlertOn}
            onChange={(e) => setVulnerableAlertOn(e.currentTarget.checked)}
            className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
            aria-label="FW: home system vulnerable"
          />
        </div>
        <div className="flex items-start justify-between gap-4 p-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              FW: nearby system flipped
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Notify when any system within this many jumps of your current
              location changes contested state. "Off" disables this alert.
            </span>
          </span>
          <div className="mt-1 flex shrink-0 overflow-hidden rounded border border-zinc-700 text-sm">
            {NEARBY_FLIP_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setNearbyFlipRadius(o.key)}
                className={`px-3 py-1 ${
                  nearbyFlipRadius === o.key
                    ? "bg-zinc-700 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-start justify-between gap-4 p-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              Check for updates
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              On startup, check GitHub for a newer release (one request to
              github.com, no account/usage data sent). Off still lets you check
              manually below.
            </span>
            <span className="mt-1 block text-xs">
              {release.isFetching && (
                <span className="text-zinc-500">Checking…</span>
              )}
              {!release.isFetching && release.isError && (
                <span className="text-rose-400">
                  Couldn't check: {errorMessage(release.error)}
                </span>
              )}
              {!release.isFetching && !release.isError && release.data && (
                <span
                  className={
                    release.data.isOutdated
                      ? "text-emerald-400"
                      : "text-zinc-500"
                  }
                >
                  {release.data.isOutdated
                    ? `v${release.data.latestVersion} is available (you're on v${release.data.currentVersion})`
                    : `Up to date (v${release.data.currentVersion})`}
                </span>
              )}
              {!release.isFetching &&
                !release.isError &&
                !release.data &&
                !checkForUpdates && (
                  <span className="text-zinc-600">Not checked yet</span>
                )}
              {release.data?.isOutdated && (
                <button
                  type="button"
                  onClick={() =>
                    void openUrl(release.data!.htmlUrl).catch(() => {})
                  }
                  className="ml-2 rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  View release
                </button>
              )}
            </span>
          </span>
          <div className="mt-1 flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => void release.refetch()}
              disabled={release.isFetching}
              className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
            >
              Check now
            </button>
            <input
              type="checkbox"
              checked={checkForUpdates}
              onChange={(e) => setCheckForUpdates(e.currentTarget.checked)}
              className="h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
              aria-label="Check for updates on startup"
            />
          </div>
        </div>
        <div className="flex items-start justify-between gap-4 p-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-zinc-100">
              Confirm before quit
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Ask before closing the app window — catches an accidental
              Alt+F4/⌘Q or a stray click on the window's close button.
            </span>
          </span>
          <input
            type="checkbox"
            checked={confirmBeforeQuit}
            onChange={(e) => setConfirmBeforeQuit(e.currentTarget.checked)}
            className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-indigo-500"
            aria-label="Confirm before quitting the app"
          />
        </div>
      </div>
    </Page>
  );
}
