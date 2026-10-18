import { useEffect } from "react";
import { zkillStreamSubscribe, zkillStreamUnsubscribe } from "./api";

/**
 * Holds a lease on the shared zKillboard killstream while `enabled` (#1060).
 * The backend websocket only runs while at least one lease is held, so every
 * feature that listens to `zkill://kill` (or reads the rolling index) mounts
 * this alongside its listener with the same condition that gates the
 * listener itself. Subscribe/unsubscribe are refcounted backend-side; an
 * unsubscribe after a failed subscribe is floored at zero there, so the
 * pairing here can stay unconditional.
 */
export function useZkillStreamLease(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    void zkillStreamSubscribe().catch((e) =>
      console.error("zkill stream subscribe failed:", e),
    );
    return () => {
      void zkillStreamUnsubscribe().catch((e) =>
        console.error("zkill stream unsubscribe failed:", e),
      );
    };
  }, [enabled]);
}
