import { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { infoList } from "../../lib/api";
import { INFO_FEED_REFRESH_INTERVAL_MS } from "../../lib/refreshIntervals";

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
 * both mount their own observer on the same `["info"]` query, so this hook
 * keeps them on one interval instead of two independently-drifting ones. */
export function useInfoFeed() {
  return useQuery({
    queryKey: ["info"],
    queryFn: infoList,
    refetchInterval: INFO_FEED_REFRESH_INTERVAL_MS,
  });
}
