import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { errorMessage, pickSyncFolder } from "../../lib/api";
import {
  pullAll,
  pushAll,
  syncNow,
  type SyncResult,
} from "../../lib/sync/syncNow";

function summarize(result: SyncResult): string {
  const parts: string[] = [];
  if (result.imported.length > 0) {
    parts.push(`imported ${result.imported.join(", ")}`);
  }
  if (result.exported.length > 0) {
    parts.push(`exported ${result.exported.join(", ")}`);
  }
  if (result.unchanged.length > 0) {
    parts.push(`unchanged ${result.unchanged.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "nothing to sync";
}

type Kind = "sync" | "push" | "pull";

const RUN: Record<Kind, (dir: string) => Promise<SyncResult>> = {
  sync: syncNow,
  push: pushAll,
  pull: pullAll,
};

const BUSY_LABEL: Record<Kind, string> = {
  sync: "Syncing…",
  push: "Pushing…",
  pull: "Pulling…",
};

const IDLE_LABEL: Record<Kind, string> = {
  sync: "Sync now",
  push: "Push all →",
  pull: "Pull all ←",
};

/**
 * The "Sync" settings section (#1128): a sync-folder path, the three sync
 * actions, and the "sync on startup" toggle. Folder-based cross-device sync
 * for just two modules (reminders + PI planner setups) — newer unix-ms
 * `updatedAt` wins per module, whole-module replace, no field merge. See
 * `lib/sync/syncNow.ts` for the algorithm.
 */
export function SyncSettingsCard() {
  const [folder, setFolder] = usePersistentState<string>(
    STORAGE_KEYS.syncFolder,
    "",
  );
  const [enabled, setEnabled] = usePersistentState<boolean>(
    STORAGE_KEYS.syncEnabled,
    false,
  );
  const [onStartup, setOnStartup] = usePersistentState<boolean>(
    STORAGE_KEYS.syncOnStartup,
    false,
  );
  const [busy, setBusy] = useState<Kind | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const hasFolder = folder.trim() !== "";
  const canRun = enabled && hasFolder && busy === null;

  async function choose() {
    try {
      const picked = await pickSyncFolder(folder.trim() || undefined);
      if (picked) {
        setFolder(picked);
        setStatus(null);
      }
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) });
    }
  }

  async function run(kind: Kind) {
    const dir = folder.trim();
    if (!enabled || !dir) {
      setStatus({ ok: false, text: "Activate sync (with a folder) first." });
      return;
    }
    if (kind === "pull") {
      const confirmed = window.confirm(
        "Pull all overwrites this device's reminders and PI planner setups " +
          "with whatever is currently in the sync folder. Continue?",
      );
      if (!confirmed) return;
    }
    setBusy(kind);
    setStatus(null);
    try {
      const result = await RUN[kind](dir);
      setStatus({ ok: true, text: summarize(result) });
      setLastSyncedAt(Date.now());
    } catch (e) {
      setStatus({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="p-4">
      <p className="text-xs text-zinc-500">
        Newer wins per module; only PI planner setups and reminders for now.
        SDE, caches and logins are never synced.
      </p>
      <div className="mt-3 grid gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-zinc-500">Sync folder</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void choose()}
              aria-label="Choose sync folder"
              title="Choose a folder your other devices also sync (Dropbox, Syncthing, Drive, …)"
              className="flex min-w-0 flex-1 items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-left font-mono text-xs text-zinc-200 hover:bg-zinc-900"
            >
              <FolderOpen size={13} className="shrink-0 text-zinc-500" />
              <span className="truncate">
                {hasFolder ? (
                  folder
                ) : (
                  <span className="text-zinc-600">Choose a folder…</span>
                )}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (!enabled && !hasFolder) {
                  setStatus({ ok: false, text: "Choose a folder first." });
                  return;
                }
                setEnabled(!enabled);
                setStatus(null);
              }}
              aria-pressed={enabled}
              className={`shrink-0 rounded px-2.5 py-1.5 text-xs ${
                enabled
                  ? "bg-emerald-700 text-white hover:bg-emerald-600"
                  : "bg-indigo-600 text-white hover:bg-indigo-500"
              }`}
            >
              {enabled ? "Active ✓" : "Activate"}
            </button>
          </div>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void run("sync")}
            disabled={!canRun}
            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          >
            {busy === "sync" ? BUSY_LABEL.sync : IDLE_LABEL.sync}
          </button>
          <button
            type="button"
            onClick={() => void run("push")}
            disabled={!canRun}
            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          >
            {busy === "push" ? BUSY_LABEL.push : IDLE_LABEL.push}
          </button>
          <button
            type="button"
            onClick={() => void run("pull")}
            disabled={!canRun}
            className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-50"
          >
            {busy === "pull" ? BUSY_LABEL.pull : IDLE_LABEL.pull}
          </button>
          <label className="ml-2 flex items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={onStartup}
              disabled={!enabled}
              onChange={(e) => setOnStartup(e.currentTarget.checked)}
              className="h-4 w-4 cursor-pointer accent-indigo-500 disabled:opacity-50"
              aria-label="Sync on startup"
            />
            Sync on startup
          </label>
        </div>
        {!enabled && hasFolder && (
          <span className="text-xs text-zinc-500">
            Folder chosen — click Activate to turn sync on.
          </span>
        )}
        {status && (
          <span
            className={`text-xs ${status.ok ? "text-emerald-400" : "text-rose-400"}`}
          >
            {status.text}
            {status.ok && lastSyncedAt !== null && (
              <span className="text-zinc-500">
                {" "}
                · last synced {new Date(lastSyncedAt).toLocaleTimeString()}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
