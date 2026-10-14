import { invoke } from "@tauri-apps/api/core";

/** Run a user-configured recording hook command (fight start/end, #1014).
 *  Placeholders are substituted by the caller; the backend spawns it detached
 *  through the platform shell and ignores its exit code. */
export function recordingRunHook(command: string): Promise<void> {
  return invoke<void>("recording_run_hook", { command });
}
