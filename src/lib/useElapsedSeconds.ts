import { useEffect, useRef, useState } from "react";

/**
 * Seconds elapsed since `active` most recently became `true`; resets to 0
 * the instant it goes true again and stops ticking (freezing at 0) once it
 * goes false. Backs the "Scanning… 12s" liveness counters on the trading
 * and daytrading scans (#850) — those scans have no backend progress signal
 * to report (the dominant cost is one opaque bulk Fuzzwork fetch per scan,
 * not a per-item loop we control), so an honest elapsed-time tick is the
 * liveness cue instead of a fabricated percentage or count.
 */
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(
        Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000),
      );
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return elapsed;
}
