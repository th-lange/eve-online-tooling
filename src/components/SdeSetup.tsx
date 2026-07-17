import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  errorMessage,
  onSdeProgress,
  sdeUpdate,
  type SdeProgress,
} from "../lib/api";

// Shown when the SDE isn't installed yet: a one-click download with live
// progress. Rendered as a body section under the page's `PageHeader` (it must
// not carry its own <h1> — the page template owns the title).
export function SdeSetup({ onInstalled }: { onInstalled: () => void }) {
  const [progress, setProgress] = useState<SdeProgress | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSdeProgress(setProgress).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  const download = useMutation({
    mutationFn: () => sdeUpdate(false),
    onSuccess: onInstalled,
  });

  const pct =
    progress && progress.total
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div className="mx-auto mt-16 max-w-xl px-6 text-center">
      <h2 className="text-2xl font-semibold text-zinc-100">
        Download EVE static data
      </h2>
      <p className="mt-3 text-zinc-400">
        This module needs the EVE Static Data Export (blueprints, items &
        materials). It's a few hundred MB and only downloads once.
      </p>

      <button
        onClick={() => download.mutate()}
        disabled={download.isPending}
        className="mt-6 rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {download.isPending ? "Downloading…" : "Download SDE"}
      </button>

      {download.isPending && (
        <div className="mt-6">
          <div className="h-2 w-full overflow-hidden rounded bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: pct !== null ? `${pct}%` : "40%" }}
            />
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            {progress?.phase ?? "starting"}
            {pct !== null ? ` — ${pct}%` : ""}
          </div>
        </div>
      )}

      {download.isError && (
        <p className="mt-4 text-sm text-rose-400">
          Download failed: {errorMessage(download.error)}
        </p>
      )}
    </div>
  );
}
