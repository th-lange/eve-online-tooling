import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { infoList } from "../../lib/api";
import { infoKeys } from "../../lib/queryKeys";
// (interval constants live in ../../lib/refreshIntervals; callers pass one in)

/** Unseen-alarm state for the Info Panel nav badge. */
export interface InfoAlerts {
  /** Count of alarm entries posted since the panel was last viewed. */
  unseen: number;
  /** Whether the feed currently has any entries at all (seen or not). */
  hasEntries: boolean;
  /** Mark the current feed as seen (clears the badge). */
  markSeen: () => void;
}

export const InfoAlertsContext = createContext<InfoAlerts>({
  unseen: 0,
  hasEntries: false,
  markSeen: () => {},
});

export function useInfoAlerts(): InfoAlerts {
  return useContext(InfoAlertsContext);
}

/** The info feed (plugin-posted alarms/messages), polled since entries don't
 * always emit a live event. Shared by `InfoPanel` and `InfoAlertsProvider` —
 * both mount their own observer on the same `["info"]` query, and TanStack
 * polls at the smallest interval any observer asks for: the always-mounted
 * root badge provider asks for a slow heartbeat, and the panel asks for the
 * fast interval only while it's actually on screen. */
export function useInfoFeed(intervalMs: number | false) {
  return useQuery({
    queryKey: infoKeys.all,
    queryFn: infoList,
    refetchInterval: intervalMs,
  });
}
