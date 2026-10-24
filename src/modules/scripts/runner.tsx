import { useEffect, useState, type ReactNode } from "react";
import { onScriptRun, onScriptSound } from "../../lib/api";
import { ScriptsRunnerContext, type ScriptRunState } from "./runnerContext";

/**
 * Bridges the background script loop to the UI. The loop itself lives in Rust
 * (a single minute-cadence timeline; see `scripts::scheduler`) — the frontend
 * no longer schedules anything. This provider just:
 *  - records each scheduled run's outcome (from the `scripts://run` event) for
 *    the per-script last-run status, and
 *  - plays sounds requested via `play_sound` (the webview can decode audio).
 */
export function ScriptsRunnerProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, ScriptRunState>>({});

  useEffect(() => {
    // `cancelled` guards the async-subscribe race: cleanup can fire BEFORE
    // `onScriptRun` resolves — a bare `unlisten?.()` would then be a no-op
    // and the old listener leaks (#1100).
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onScriptRun(({ id, run }) =>
      setRuns((prev) => ({ ...prev, [id]: { at: Date.now(), run } })),
    ).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // Same cancelled-guard race as above, for `onScriptSound` (#1100).
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    onScriptSound(({ mime, data }) => {
      const audio = new Audio(`data:${mime};base64,${data}`);
      void audio
        .play()
        .catch((e) => console.error("Script sound playback failed", e));
    }).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <ScriptsRunnerContext.Provider value={runs}>
      {children}
    </ScriptsRunnerContext.Provider>
  );
}
