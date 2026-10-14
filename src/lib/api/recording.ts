import { invoke } from "@tauri-apps/api/core";

/** Run a user-configured recording hook command (fight start/end, #1014).
 *  Placeholders are substituted by the caller; the backend spawns it detached
 *  through the platform shell and ignores its exit code. */
export function recordingRunHook(command: string): Promise<void> {
  return invoke<void>("recording_run_hook", { command });
}

/** obs-websocket connection settings (#1015). Password empty when OBS auth
 *  is disabled. */
export interface ObsSettings {
  url: string;
  password?: string;
}

/** Settings "Test connection" — resolves to the OBS version string. */
export function obsTestConnection(settings: ObsSettings): Promise<string> {
  return invoke<string>("obs_test_connection", { settings });
}

/** Fight start: SaveReplayBuffer (pre-fight seconds, when the buffer is on)
 *  + StartRecord. Per-request failures are tolerated backend-side. */
export function obsFightStarted(settings: ObsSettings): Promise<void> {
  return invoke<void>("obs_fight_started", { settings });
}

/** Fight end (after the post-roll): StopRecord; resolves to the clip path
 *  when OBS reports one. */
export function obsFightEnded(settings: ObsSettings): Promise<string | null> {
  return invoke<string | null>("obs_fight_ended", { settings });
}
