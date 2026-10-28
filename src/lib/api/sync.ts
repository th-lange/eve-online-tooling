import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

// --- Folder sync (#1128) ---
//
// A thin transport: read/write JSON files in a user-chosen folder. All
// sync *decisions* (newer-wins, which modules sync) live in the frontend —
// see `lib/sync/`.

/** One `*.json` file read back from a sync folder: its bare filename and raw
 *  (unparsed) content. */
export interface SyncFile {
  name: string;
  content: string;
}

/** Every top-level `*.json` file in `dir`, in one round trip. */
export function syncFolderRead(dir: string): Promise<SyncFile[]> {
  return invoke<SyncFile[]>("sync_folder_read", { dir });
}

/** Write `content` to `dir/<name>`, creating `dir` if it doesn't exist yet. */
export function syncFolderWrite(
  dir: string,
  name: string,
  content: string,
): Promise<void> {
  return invoke<void>("sync_folder_write", { dir, name, content });
}

/** Open the native folder picker, returning the chosen absolute path, or
 *  `null` if cancelled. `current` seeds the dialog's starting location.
 *  Only works under Tauri; callers guard for the browser-dev case. */
export async function pickSyncFolder(current?: string): Promise<string | null> {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath: current || undefined,
  });
  return typeof picked === "string" ? picked : null;
}
